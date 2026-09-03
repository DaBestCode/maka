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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import {
  collectRuntimeHostSessionCatalogsWithCoverage,
  createRuntimeHostSessionCatalogRefresher,
  recordObservedRuntimeHostSessionAuthority,
  reconcileRuntimeHostSessionCatalog,
  resolveRuntimeHostSessionCatalog,
} from '../../preload/runtime-host-session-catalog.js';

function session(id: string, activityAt: number): DesktopSessionSummary {
  return { id, activityAt } as DesktopSessionSummary;
}

test('does not lose a catalog refresh admitted while the previous read settles', async () => {
  let resolveFirst!: (sessions: DesktopSessionSummary[]) => void;
  const firstRead = new Promise<DesktopSessionSummary[]>((resolve) => {
    resolveFirst = resolve;
  });
  const stale = session('stale', 1);
  const fresh = session('fresh', 2);
  let reads = 0;
  let current: DesktopSessionSummary[] = [];
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listSessions: () => (++reads === 1 ? firstRead : Promise.resolve([fresh])),
    currentSessions: () => current,
    commitSessions: (sessions) => {
      current = sessions;
    },
  });

  const first = refresher.refresh();
  resolveFirst([stale]);
  let second: Promise<DesktopSessionSummary[]> | undefined;
  queueMicrotask(() => {
    second = refresher.refresh();
  });

  assert.deepEqual(await first, [stale]);
  await Promise.resolve();
  assert.ok(second);
  assert.deepEqual(await second, [fresh]);
  assert.equal(reads, 2);
});

test('does not commit a catalog read superseded while it is in flight', async () => {
  let resolveFirst!: (sessions: DesktopSessionSummary[]) => void;
  const firstRead = new Promise<DesktopSessionSummary[]>((resolve) => {
    resolveFirst = resolve;
  });
  const stale = session('stale', 1);
  const fresh = session('fresh', 2);
  const commits: DesktopSessionSummary[][] = [];
  let reads = 0;
  let current: DesktopSessionSummary[] = [];
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listSessions: () => (++reads === 1 ? firstRead : Promise.resolve([fresh])),
    currentSessions: () => current,
    commitSessions: (sessions) => {
      current = sessions;
      commits.push(sessions);
    },
  });

  const first = refresher.refresh();
  const second = refresher.refresh();
  resolveFirst([stale]);

  assert.deepEqual(await first, [fresh]);
  assert.deepEqual(await second, [fresh]);
  assert.deepEqual(commits, [[fresh]]);
  assert.equal(reads, 2);
});

test('continues to an admitted trailing read after a superseded read fails', async () => {
  let rejectFirst!: (error: Error) => void;
  const firstRead = new Promise<DesktopSessionSummary[]>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const fresh = session('fresh', 2);
  let reads = 0;
  let current: DesktopSessionSummary[] = [];
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listSessions: () => (++reads === 1 ? firstRead : Promise.resolve([fresh])),
    currentSessions: () => current,
    commitSessions: (sessions) => {
      current = sessions;
    },
  });

  const first = refresher.refresh();
  const second = refresher.refresh();
  rejectFirst(new Error('superseded'));

  assert.deepEqual(await first, [fresh]);
  assert.deepEqual(await second, [fresh]);
  assert.equal(reads, 2);
});

test('keeps healthy Host catalogs when another Host rejects', async () => {
  const catalog = await collectRuntimeHostSessionCatalogsWithCoverage([
    {
      hostId: 'older',
      profileId: 'older-owner',
      access: 'owner',
      sessions: Promise.resolve([session('older', 1)]),
    },
    {
      hostId: 'unavailable',
      profileId: 'unavailable-owner',
      access: 'owner',
      sessions: Promise.reject(new Error('remote unavailable')),
    },
    {
      hostId: 'newer',
      profileId: 'newer-owner',
      access: 'owner',
      sessions: Promise.resolve([session('newer', 2)]),
    },
  ]);

  assert.deepEqual(
    catalog.sessions.map(({ id }) => id),
    ['newer', 'older'],
  );
});

test('reports exactly which Host catalogs are complete', async () => {
  const catalog = await collectRuntimeHostSessionCatalogsWithCoverage([
    {
      hostId: 'local',
      profileId: 'local-owner',
      access: 'owner',
      sessions: Promise.resolve([session('local-session', 1)]),
    },
    {
      hostId: 'remote',
      profileId: 'remote-owner',
      access: 'owner',
      sessions: Promise.reject(new Error('remote unavailable')),
    },
  ]);

  assert.deepEqual(
    catalog.sessions.map(({ id }) => id),
    ['local-session'],
  );
  assert.deepEqual(catalog.completeHostIds, ['local']);
});

test('collapses overlapping Guest catalogs in favor of the Owner authority', async () => {
  const owner = session('shared-session', 2);
  const guest = { ...owner, shared: true as const };

  const catalog = await collectRuntimeHostSessionCatalogsWithCoverage([
    {
      hostId: 'shared',
      profileId: 'shared-guest',
      access: 'session_guest',
      sessions: Promise.resolve([guest]),
    },
    {
      hostId: 'shared',
      profileId: 'shared-owner',
      access: 'owner',
      sessions: Promise.resolve([owner]),
    },
  ]);

  assert.deepEqual(catalog.sessions, [owner]);
});

test('a complete Guest catalog does not retire another mount on the same Host', async () => {
  const guestA = {
    ...session('guest-a', 3),
    runtimeHostId: 'shared-host',
    profileId: 'guest-profile-a',
    shared: true as const,
  };
  const guestB = {
    ...session('guest-b', 2),
    runtimeHostId: 'shared-host',
    profileId: 'guest-profile-b',
    shared: true as const,
  };
  const coverage = await collectRuntimeHostSessionCatalogsWithCoverage([
    {
      hostId: 'shared-host',
      profileId: 'guest-profile-a',
      access: 'session_guest',
      sessions: Promise.resolve([guestA]),
    },
    {
      hostId: 'shared-host',
      profileId: 'guest-profile-b',
      access: 'session_guest',
      sessions: Promise.reject(new Error('still reconnecting')),
    },
  ]);

  assert.deepEqual(coverage.completeHostIds, []);
  assert.deepEqual(coverage.completeGuestProfileIds, ['guest-profile-a']);
  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([guestA, guestB], {
      ...coverage,
      knownProfileIds: ['guest-profile-a', 'guest-profile-b'],
    }).map(({ id }) => id),
    ['guest-a', 'guest-b'],
  );
});

test('retains a Guest catalog row only while its Runtime Host profile remains known', () => {
  const shared = {
    ...session('shared-session', 2),
    runtimeHostId: 'host-guest',
    profileId: 'guest-profile',
    shared: true as const,
  };

  const reconnecting = reconcileRuntimeHostSessionCatalog([shared], {
    sessions: [],
    completeHostIds: [],
    completeGuestProfileIds: [],
    knownProfileIds: ['guest-profile'],
  });
  assert.deepEqual(reconnecting, [shared]);

  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog(reconnecting, {
      sessions: [{ ...shared, activityAt: 3 }],
      completeHostIds: ['host-guest'],
      completeGuestProfileIds: [],
      knownProfileIds: ['guest-profile'],
    }),
    [{ ...shared, activityAt: 3 }],
  );

  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog(reconnecting, {
      sessions: [],
      completeHostIds: [],
      completeGuestProfileIds: [],
      knownProfileIds: [],
    }),
    [],
  );
});

test('restores an authenticated Guest row from durable mount metadata after restart', async () => {
  const retained = {
    ...session('shared-session', 2),
    runtimeHostId: 'guest-host',
    profileId: 'guest-profile',
    shared: true as const,
  };

  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [],
      Promise.resolve({
        sessions: [],
        completeHostIds: [],
        completeGuestProfileIds: [],
      }),
      () => [],
      Promise.resolve([retained]),
    ),
    [retained],
  );
});

test('uses the newer retained projection while its Guest catalog is unavailable', async () => {
  const cached = {
    ...session('shared-session', 1),
    runtimeHostId: 'guest-host',
    profileId: 'guest-profile',
    name: 'old',
    revision: 1,
    shared: true as const,
  };
  const retained = {
    ...cached,
    activityAt: 2,
    name: 'fresh',
    revision: 2,
  };

  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [cached],
      Promise.resolve({
        sessions: [],
        completeHostIds: [],
        completeGuestProfileIds: [],
      }),
      () => [],
      Promise.resolve([retained]),
    ),
    [retained],
  );

  const live = { ...cached, name: 'live' };
  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [cached],
      Promise.resolve({
        sessions: [live],
        completeHostIds: [],
        completeGuestProfileIds: ['guest-profile'],
      }),
      () => [],
      Promise.resolve([retained]),
    ),
    [live],
  );
});

test('keeps a live Guest authority when its retained Owner catalog is unavailable', () => {
  const retainedOwner = {
    ...session('shared-session', 1),
    runtimeHostId: 'shared-host',
    profileId: 'owner-profile',
    name: 'stale owner row',
  };
  const liveGuest = {
    ...retainedOwner,
    profileId: 'guest-profile',
    name: 'live guest row',
    shared: true as const,
  };

  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([retainedOwner], {
      sessions: [liveGuest],
      completeHostIds: [],
      completeGuestProfileIds: ['guest-profile'],
      knownProfileIds: ['owner-profile', 'guest-profile'],
    }),
    [liveGuest],
  );
});

test('retires the cached Guest row when its durable projection is revoked', async () => {
  const retained = {
    ...session('shared-session', 2),
    runtimeHostId: 'guest-host',
    profileId: 'guest-profile',
    shared: true as const,
  };

  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [retained],
      Promise.resolve({
        sessions: [],
        completeHostIds: [],
        completeGuestProfileIds: [],
      }),
      () => [],
      Promise.resolve([]),
    ),
    [],
  );
});

test('keeps healthy Owner catalogs when Guest mount inventory is unavailable', async () => {
  const owner = {
    ...session('owner-session', 3),
    runtimeHostId: 'owner-host',
    profileId: 'owner-profile',
  };
  const shared = {
    ...session('shared-session', 2),
    runtimeHostId: 'guest-host',
    profileId: 'guest-profile',
    shared: true as const,
  };

  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [shared],
      Promise.resolve({
        sessions: [owner],
        completeHostIds: ['owner-host'],
        completeGuestProfileIds: [],
      }),
      () => ['owner-profile'],
      Promise.reject(new Error('Guest mount store is unreadable')),
    ),
    [owner, shared],
  );
});

test('keeps incomplete coverage when every live catalog rejects', async () => {
  assert.deepEqual(
    await collectRuntimeHostSessionCatalogsWithCoverage([
      {
        hostId: 'first',
        profileId: 'first-owner',
        access: 'owner',
        sessions: Promise.reject(new Error('first unavailable')),
      },
      {
        hostId: 'second',
        profileId: 'second-owner',
        access: 'owner',
        sessions: Promise.reject(new Error('second unavailable')),
      },
    ]),
    { sessions: [], completeHostIds: [], completeGuestProfileIds: [] },
  );
});

test('uses retained Guest inventory even when every live catalog rejects', async () => {
  const owner = {
    ...session('owner-session', 3),
    runtimeHostId: 'owner-host',
    profileId: 'owner-profile',
  };
  const revokedGuest = {
    ...session('shared-session', 2),
    runtimeHostId: 'guest-host',
    profileId: 'guest-profile',
    shared: true as const,
  };

  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [owner, revokedGuest],
      collectRuntimeHostSessionCatalogsWithCoverage([
        {
          hostId: 'owner-host',
          profileId: 'owner-profile',
          access: 'owner',
          sessions: Promise.reject(new Error('owner unavailable')),
        },
        {
          hostId: 'guest-host',
          profileId: 'guest-profile',
          access: 'session_guest',
          sessions: Promise.reject(new Error('guest unavailable')),
        },
      ]),
      () => ['owner-profile'],
      Promise.resolve([]),
    ),
    [owner],
  );
});

test('an observed Guest event cannot replace an accepted Owner authority', () => {
  const authorities = new Map([['shared-session', 'owner-profile']]);

  assert.equal(
    recordObservedRuntimeHostSessionAuthority(authorities, 'shared-session', 'guest-profile'),
    false,
  );
  assert.equal(authorities.get('shared-session'), 'owner-profile');
  assert.equal(
    recordObservedRuntimeHostSessionAuthority(authorities, 'new-session', 'guest-profile'),
    true,
  );
  assert.equal(authorities.get('new-session'), 'guest-profile');
});
