/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { DesktopSessionSummary } from './bridge-contract.js';

export interface RuntimeHostSessionCatalogRequest {
  readonly hostId: string;
  readonly profileId: string;
  readonly access: 'owner' | 'session_guest';
  readonly sessions: Promise<DesktopSessionSummary[]>;
}

export interface RuntimeHostSessionCatalogCoverage {
  readonly sessions: DesktopSessionSummary[];
  /** Hosts whose Owner catalog answered authoritatively. */
  readonly completeHostIds: string[];
  /** Guest profiles whose single-session catalog answered authoritatively. */
  readonly completeGuestProfileIds: string[];
}

export interface RuntimeHostSessionCatalogSnapshot extends RuntimeHostSessionCatalogCoverage {
  /** Profiles still retained by Desktop, including unavailable Guest mounts. */
  readonly knownProfileIds: string[];
  /** Last authenticated Guest rows retained across a Desktop restart. */
  readonly retainedGuestSessions?: DesktopSessionSummary[];
}

export interface RuntimeHostSessionCatalogRefresher {
  refresh(): Promise<DesktopSessionSummary[]>;
}

export function createRuntimeHostSessionCatalogRefresher(input: {
  readonly listSessions: () => Promise<DesktopSessionSummary[]>;
  readonly currentSessions: () => DesktopSessionSummary[];
  readonly commitSessions: (sessions: DesktopSessionSummary[]) => void;
}): RuntimeHostSessionCatalogRefresher {
  let dirty = false;
  let active: Promise<DesktopSessionSummary[]> | undefined;
  const drain = async (): Promise<DesktopSessionSummary[]> => {
    try {
      let sessions = input.currentSessions();
      do {
        dirty = false;
        try {
          const candidate = await input.listSessions();
          // A later invalidation supersedes this observation before it can
          // mutate the authority map. The trailing read is the one to commit.
          if (dirty) continue;
          sessions = candidate;
          input.commitSessions(candidate);
        } catch (error) {
          // Like a successful stale read, a superseded failure cannot decide
          // the drain. Let the already-admitted trailing read decide instead.
          if (!dirty) throw error;
          sessions = input.currentSessions();
        }
      } while (dirty);
      return sessions;
    } finally {
      active = undefined;
    }
  };
  return {
    refresh() {
      dirty = true;
      if (!active) active = drain();
      return active;
    },
  };
}

export async function resolveRuntimeHostSessionCatalog(
  current: readonly DesktopSessionSummary[],
  coverage: Promise<RuntimeHostSessionCatalogCoverage>,
  knownOwnerProfileIds: () => readonly string[],
  retainedGuestSessions: Promise<DesktopSessionSummary[]>,
): Promise<DesktopSessionSummary[]> {
  const [snapshot, retainedGuests] = await Promise.all([
    coverage,
    retainedGuestSessions.catch(() => current.filter((session) => session.shared === true)),
  ]);
  return reconcileRuntimeHostSessionCatalog(current, {
    ...snapshot,
    knownProfileIds: [
      ...knownOwnerProfileIds(),
      ...retainedGuests.map(({ profileId }) => profileId),
    ],
    retainedGuestSessions: retainedGuests,
  });
}

export async function collectRuntimeHostSessionCatalogsWithCoverage(
  requests: readonly RuntimeHostSessionCatalogRequest[],
): Promise<RuntimeHostSessionCatalogCoverage> {
  const results = await Promise.allSettled(requests.map((request) => request.sessions));
  const fulfilled = results.flatMap((result, index) =>
    result.status === 'fulfilled' ? [{ ...requests[index]!, sessions: result.value }] : [],
  );
  const completeHostIds = new Set<string>();
  const completeGuestProfileIds = new Set<string>();
  for (const request of fulfilled) {
    if (request.access === 'owner') completeHostIds.add(request.hostId);
    else completeGuestProfileIds.add(request.profileId);
  }
  return {
    sessions: sortSessionCatalogs(fulfilled.flatMap((entry) => entry.sessions)),
    completeHostIds: [...completeHostIds],
    completeGuestProfileIds: [...completeGuestProfileIds],
  };
}

/**
 * An observation may establish an unknown Session authority, but only an
 * accepted catalog may replace one. Returns false when the observation came
 * from a different profile and should therefore trigger a generic refresh.
 */
export function recordObservedRuntimeHostSessionAuthority(
  authorities: Map<string, string>,
  sessionId: string,
  profileId: string,
): boolean {
  const accepted = authorities.get(sessionId);
  if (accepted === undefined) {
    authorities.set(sessionId, profileId);
    return true;
  }
  return accepted === profileId;
}

/**
 * Commits complete Owner catalogs per Host and Guest catalogs per profile,
 * while retaining the last accepted rows for an authority that cannot answer.
 * An explicitly removed profile is absent from knownProfileIds and therefore
 * retires immediately; transport availability alone cannot change access.
 */
export function reconcileRuntimeHostSessionCatalog(
  current: readonly DesktopSessionSummary[],
  snapshot: RuntimeHostSessionCatalogSnapshot,
): DesktopSessionSummary[] {
  const completeHostIds = new Set(snapshot.completeHostIds);
  const completeGuestProfileIds = new Set(snapshot.completeGuestProfileIds);
  const knownProfileIds = new Set(snapshot.knownProfileIds);
  const retainable = (session: DesktopSessionSummary) =>
    knownProfileIds.has(session.profileId) &&
    !completeHostIds.has(session.runtimeHostId) &&
    !completeGuestProfileIds.has(session.profileId);
  const retained = mergeRetainedGuestSessions(
    current.filter(retainable),
    (snapshot.retainedGuestSessions ?? []).filter(retainable),
  );
  // A fulfilled catalog is the newest authenticated authority observation.
  // Retained rows only fill gaps; even an Owner-shaped cache must not replace
  // a live Guest row when the Owner profile could not answer this refresh.
  const live = sortSessionCatalogs(snapshot.sessions);
  const liveSessionIds = new Set(live.map(({ id }) => id));
  return sortSessionCatalogs([...live, ...retained.filter(({ id }) => !liveSessionIds.has(id))]);
}

function mergeRetainedGuestSessions(
  current: readonly DesktopSessionSummary[],
  retained: readonly DesktopSessionSummary[],
): DesktopSessionSummary[] {
  const unique = new Map(current.map((session) => [session.id, session]));
  for (const session of retained) {
    const cached = unique.get(session.id);
    if (!cached) {
      unique.set(session.id, session);
      continue;
    }
    if (
      cached.shared === true &&
      session.shared === true &&
      cached.profileId === session.profileId &&
      session.revision !== undefined &&
      (cached.revision === undefined || session.revision > cached.revision)
    ) {
      unique.set(session.id, session);
    }
  }
  return [...unique.values()];
}

function sortSessionCatalogs(sessions: DesktopSessionSummary[]): DesktopSessionSummary[] {
  const unique = new Map<string, DesktopSessionSummary>();
  for (const session of sessions) {
    const current = unique.get(session.id);
    if (!current || (current.shared === true && session.shared !== true)) {
      unique.set(session.id, session);
    }
  }
  return [...unique.values()].sort((left, right) => {
    if (left.activityAt === undefined || right.activityAt === undefined) {
      throw new Error('Runtime Host Session Catalog activity is unavailable');
    }
    return right.activityAt - left.activityAt || left.id.localeCompare(right.id);
  });
}
