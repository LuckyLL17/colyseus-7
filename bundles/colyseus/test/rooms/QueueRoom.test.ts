import assert from "assert";
import { QueueRoom, Room, defineRoom, defineServer, generateId, matchMaker, QueueReason, type Client, type QueueStatus, type QueueMatchScore } from "../../src/index.ts";

const clientMessages: { [sessionId: string]: any[] } = {};

export function createClient(room: Room, clientOptions: any) {
  const sessionId = generateId();
  const client = {
    sessionId,
    auth: undefined,
    send: function (type: string, message: any) {
      if (!clientMessages[sessionId]) { clientMessages[sessionId] = []; }
      clientMessages[sessionId].push({ type, message });
    },
    leave: function (this: any, _code?: number) {
      const idx = room.clients.findIndex((c) => c.sessionId === sessionId);
      if (idx !== -1) {
        const leaving = room.clients[idx];
        room.clients.splice(idx, 1);
        (room as QueueRoom).onLeave?.(leaving as Client, 1000);
      }
    },
  } as Client;
  room.onJoin!(client, clientOptions);
  room.clients.push(client);
  return client;
}

function lastMessage(client: any, type: string) {
  const msgs = clientMessages[client.sessionId] || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === type) { return msgs[i].message; }
  }
  return undefined;
}

describe("QueueRoom", () => {
  describe("Unit Test", () => {
    let room: QueueRoom;

    beforeEach(() => {
      room = new QueueRoom();
      room.onCreate({ matchRoomName: "my_room" });

      /**
       * Mock `checkGroupsReady()` method for testing
       */
      room.processGroupsReady = () => Promise.resolve();
    });

    // afterEach(() => room.onDispose());

    describe("group distribution", () => {
      it("should create acceptance group", () => {
        createClient(room, { rank: 10 });

        room.reassignMatchGroups();

        assert.strictEqual(1, room.groups.length);
        assert.strictEqual(1, room.groups[0].clients.length);
      });

      it("should join the same group", () => {
        createClient(room, { rank: 10 });
        createClient(room, { rank: 20 });

        room.reassignMatchGroups();

        assert.strictEqual(1, room.groups.length);
      });

      it("should create new group once number of allowed clients has been reached", () => {
        room.maxPlayers = 4;

        // group 1
        createClient(room, { rank: 10 });
        createClient(room, { rank: 20 });
        createClient(room, { rank: 30 });
        createClient(room, { rank: 40 });

        // group 2
        createClient(room, { rank: 50 });
        createClient(room, { rank: 20 });

        room.reassignMatchGroups();

        assert.strictEqual(2, room.groups.length);
        assert.strictEqual(20, room.groups[0].averageRank);
        assert.strictEqual(45, room.groups[1].averageRank);

        assert.strictEqual(4, room.groups[0].clients.length);
        assert.strictEqual(2, room.groups[1].clients.length);
      });

      it("should redistribute existing clients withing existing groups", () => {
        room.maxPlayers = 4;

        createClient(room, { rank: 10 });
        createClient(room, { rank: 20 });
        createClient(room, { rank: 30 });
        createClient(room, { rank: 40 });

        createClient(room, { rank: 50 });
        createClient(room, { rank: 20 });
        createClient(room, { rank: 25 });
        createClient(room, { rank: 28 });

        createClient(room, { rank: 70 });
        createClient(room, { rank: 100 });
        createClient(room, { rank: 45 });
        createClient(room, { rank: 43 });

        room.reassignMatchGroups();

        assert.strictEqual(18.75, room.groups[0].averageRank);
        assert.strictEqual(35.25, room.groups[1].averageRank);
        assert.strictEqual(66.25, room.groups[2].averageRank);
      });

      it("should distribute better matching ranks", () => {
        room.maxPlayers = 4;

        createClient(room, { rank: 1 });
        createClient(room, { rank: 30 });
        createClient(room, { rank: 50 });
        createClient(room, { rank: 60 });
        createClient(room, { rank: 40 });
        room.reassignMatchGroups();

        assert.strictEqual(1, room.groups[0].averageRank);
        assert.strictEqual(45, room.groups[1].averageRank);
      });

      it("groups should be compatible when highPriority = true", () => {
        room.maxPlayers = 4;
        room.maxWaitingCyclesForPriority = 3;

        createClient(room, { rank: 95 });
        room.reassignMatchGroups();

        createClient(room, { rank: 1 });
        createClient(room, { rank: 80 });
        createClient(room, { rank: 100 });

        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();

        createClient(room, { rank: 100 });
        room.reassignMatchGroups();

        assert.ok(room.groups[1].averageRank > 90);
        assert.strictEqual(1, room.groups[0].averageRank);
      });
    });

    describe("diff ratio", () => {
      it("should match 0-4 rank together", () => {
        room.maxPlayers = 4;
        room.maxWaitingCycles = 5;

        createClient(room, { rank: 0 });
        createClient(room, { rank: 1 });
        createClient(room, { rank: 1 });
        createClient(room, { rank: 4 });

        room.reassignMatchGroups();

        const readyGroups = room.groups.filter(g => g.ready);
        assert.strictEqual(1, readyGroups.length);
        assert.strictEqual(4, readyGroups[0].clients.length);
      });
    });

    describe("allowIncompleteGroups", () => {
      beforeEach(() => room.allowIncompleteGroups = true);

      it("should allow incomplete groups if maxWaitingCycles has reached", () => {
        room.maxPlayers = 4;
        room.maxWaitingCycles = 5;

        createClient(room, { rank: 10 });
        createClient(room, { rank: 90 });
        createClient(room, { rank: 20 });

        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();

        createClient(room, { rank: 80 });
        room.reassignMatchGroups();

        assert.strictEqual(2, room.groups.length);

        createClient(room, { rank: 100 });
        room.reassignMatchGroups();

        assert.strictEqual(true, room.groups[0].ready);
        assert.strictEqual(false, room.groups[1].ready);

        // cycle through the groups, and check if the group is ready
        room.reassignMatchGroups();
        assert.strictEqual(true, room.groups[0].ready);
      });

      it("should create match of 3", () => {
        room.maxPlayers = 4;
        room.maxWaitingCycles = 5;

        createClient(room, { rank: 78 });
        createClient(room, { rank: 35 });
        createClient(room, { rank: 60 });

        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();
        room.reassignMatchGroups();

        assert.strictEqual(1, room.groups.length);
        assert.strictEqual(true, room.groups[0].ready);
      });

    });

    describe("should support pre-defined teams", () => {
      it("A/B teams: 2 teams of 2", () => {
        room.maxPlayers = 4;
        room.maxTeamSize = 2;

        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });

        room.reassignMatchGroups();

        assert.strictEqual(2, room.groups.length);
        assert.strictEqual(4, room.groups[0].clients.length);
        assert.strictEqual(true, room.groups[0].ready);
      });

      it("A/B/C teams, match A+B, C keeps waiting", () => {
        room.maxPlayers = 4;
        room.maxTeamSize = 2;

        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "C" });

        room.reassignMatchGroups();

        assert.strictEqual(2, room.groups.length);
        assert.strictEqual(4, room.groups[0].clients.length);
        assert.strictEqual(true, room.groups[0].ready);
      });

      it("multiple A/B teams of 2", () => {
        room.maxPlayers = 4;
        room.maxTeamSize = 2;

        for (let i = 0; i < 10; i++) {
          createClient(room, { rank: 10, teamId: "A" });
          createClient(room, { rank: 10, teamId: "B" });
        }

        room.reassignMatchGroups();

        const readyGroups = room.groups.filter(g => g.ready && g.clients.length === 4);
        assert.strictEqual(5, readyGroups.length);
      });

      it("A/B/C teams, 9 players, 3 each team", () => {
        room.maxPlayers = 9;
        room.maxTeamSize = 3;

        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "C" });
        createClient(room, { rank: 10, teamId: "C" });
        createClient(room, { rank: 10, teamId: "C" });

        room.reassignMatchGroups();

        const readyGroups = room.groups.filter(g => g.ready);
        assert.strictEqual(1, readyGroups.length);
        assert.strictEqual(9, readyGroups[0].clients.length);
        assert.strictEqual(true, readyGroups[0].ready);
      });
    });

  });

  // ---------------------------------------------------------------------------
  // Explainable scoring, queue status and seat-reservation lifecycle
  // ---------------------------------------------------------------------------

  describe("explainable scoring & queue status", () => {
    let featureRoom: QueueRoom;

    beforeEach(() => {
      featureRoom = new QueueRoom();
      featureRoom.onCreate({ matchRoomName: "my_room" });
      // do not actually create rooms in unit tests
      featureRoom.processGroupsReady = () => undefined;
      for (const key in clientMessages) { delete clientMessages[key]; }
    });

    it("produces wait/rank/region score breakdown", () => {
      featureRoom.rankRangeIdeal = 10;
      featureRoom.rankRangeMax = 100;

      const a = createClient(featureRoom, { rank: 50 });
      a.userData.enqueuedAt = Date.now() - 5000;
      featureRoom.reassignMatchGroups();

      const b = createClient(featureRoom, { rank: 55 });
      b.userData.enqueuedAt = Date.now();
      featureRoom.reassignMatchGroups();

      const status: QueueStatus = lastMessage(b, "status");
      assert.ok(status);
      assert.strictEqual(status.reason, QueueReason.GATHERING);
      assert.strictEqual(status.groupSize, 2);
      assert.strictEqual(status.missingPlayers, 2);
      assert.ok(status.waitingTime >= 0);
      assert.ok(status.estimatedWaitTime >= 0);

      const score: QueueMatchScore = status.lastScore!;
      assert.ok(score.rank > 0.9, "rank proximity should be near 1");
      assert.ok(score.wait >= 0 && score.wait <= 1);
      assert.strictEqual(score.region, 1); // region-neutral client
      assert.strictEqual(score.compatible, true);
      assert.ok(score.total > 0 && score.total <= 1);
    });

    it("reports rank-mismatch reason and skips incompatible group", () => {
      featureRoom.maxPlayers = 4;

      createClient(featureRoom, { rank: 10 });
      createClient(featureRoom, { rank: 12 });
      featureRoom.reassignMatchGroups();

      const far = createClient(featureRoom, { rank: 500 });
      featureRoom.reassignMatchGroups();

      const status: QueueStatus = lastMessage(far, "status");
      assert.strictEqual(status.reason, QueueReason.RANK_MISMATCH);
      assert.ok(status.lastScore!.rank < 0.5);
      assert.strictEqual(status.lastScore!.compatible, false);

      // candidate started its own group rather than force-merging
      assert.strictEqual(2, featureRoom.groups.length);
      assert.strictEqual(1, featureRoom.groups[1].clients.length);
    });

    it("penalizes distant regions via proximity table", () => {
      featureRoom.regionProximity = {
        "us-east": { "us-east": 1, "us-west": 0.7, "eu-west": 0.2 },
        "us-west": { "us-west": 1, "us-east": 0.7, "eu-west": 0.4 },
        "eu-west": { "eu-west": 1, "us-east": 0.2, "us-west": 0.4 },
      };

      createClient(featureRoom, { rank: 50, region: "us-east" });
      featureRoom.reassignMatchGroups();

      const eu = createClient(featureRoom, { rank: 52, region: "eu-west" });
      featureRoom.reassignMatchGroups();

      const score = lastMessage(eu, "status").lastScore;
      assert.ok(score.region <= 0.21);
      // ranks are compatible, so they still group, but score explains the penalty
      assert.strictEqual(featureRoom.groups[0].clients.length, 2);
    });

    it("prefers the better-scoring open group", () => {
      featureRoom.maxPlayers = 4;

      createClient(featureRoom, { rank: 10 });
      createClient(featureRoom, { rank: 12 });
      createClient(featureRoom, { rank: 90 });
      createClient(featureRoom, { rank: 95 });
      featureRoom.reassignMatchGroups();
      assert.strictEqual(2, featureRoom.groups.length);

      const mid = createClient(featureRoom, { rank: 96 });
      featureRoom.reassignMatchGroups();

      // candidate joined the high-rank group even though it was processed after
      assert.ok(featureRoom.groups.find((g) => g.clients.some((c) => c.sessionId === mid.sessionId))!.averageRank > 90);
    });

    it("reports an ETA derived from missing players and arrival rate", () => {
      featureRoom.maxPlayers = 4;
      featureRoom.cycleTickInterval = 1000;

      createClient(featureRoom, { rank: 10 });
      featureRoom.reassignMatchGroups();

      const status: QueueStatus = lastMessage(featureRoom.clients[0] as any, "status");
      assert.strictEqual(status.missingPlayers, 3);
      assert.ok(status.estimatedWaitTime > 0);
    });
  });

  describe("candidate skipping on bad room size", () => {
    it("re-queues the group when the target room cannot fit it", async () => {
      for (const key in clientMessages) { delete clientMessages[key]; }

      const sizeRoom = new QueueRoom();
      sizeRoom.onCreate({
        matchRoomName: "my_room",
        onGroupReady: async () => ({
          name: "my_room",
          roomId: "xyz",
          processId: "p1",
          clients: 2,
          maxClients: 3, // a group of 4 cannot fit
          locked: false,
          private: false,
        }),
      });

      for (let i = 0; i < 4; i++) {
        createClient(sizeRoom, { rank: 10 + i });
      }
      sizeRoom.reassignMatchGroups();

      // wait for the async dispatch rollback
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.strictEqual(sizeRoom.groups.find((g) => g.ready), undefined);

      const status: QueueStatus = lastMessage(sizeRoom.clients[0] as any, "status");
      assert.strictEqual(status.reason, QueueReason.TEAM_TOO_LARGE);
    });
  });

  describe("seat reservation lifecycle", () => {
    beforeEach(() => {
      for (const key in clientMessages) { delete clientMessages[key]; }
    });

    it("rolls the group back on room creation failure (no disconnects)", async () => {
      const failRoom = new QueueRoom();
      failRoom.onCreate({
        matchRoomName: "my_room",
        onGroupReady: async () => { throw new Error("boom"); },
      });

      const clients: any[] = [];
      for (let i = 0; i < 4; i++) {
        clients.push(createClient(failRoom, { rank: 10 + i }));
      }
      failRoom.reassignMatchGroups();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // nobody was kicked
      assert.strictEqual(4, failRoom.clients.length);
      // retry state is visible
      assert.strictEqual(lastMessage(clients[0], "status").reason, QueueReason.RETRYING);
      // no leaked reservation
      assert.strictEqual(0, (failRoom as any).activeReservations.length);
    });

    it("reclaims expired reservations and re-queues clients", async () => {
      const expRoom = new QueueRoom();
      expRoom.onCreate({ matchRoomName: "my_room" });
      (expRoom as any).seatReservationGraceTime = -20000; // expire immediately vs 15s default

      const created: any = {
        name: "my_room", roomId: "r1", processId: "p-test",
        clients: 0, maxClients: 4, locked: false, private: false,
      };
      (expRoom as any).onGroupReady = async () => created;
      (expRoom as any).reserveSeats = async (_r: any, data: any[]) => data.map(() => true);

      const releaseCalls: string[][] = [];
      const disposeCalls: string[] = [];
      (expRoom as any).releaseSeats = async (_r: any, sessionIds: string[]) => {
        releaseCalls.push(sessionIds);
        return sessionIds.map(() => true);
      };
      (expRoom as any).disposeEmptyRoom = async (r: any) => {
        disposeCalls.push(r.roomId);
        return true;
      };

      for (let i = 0; i < 4; i++) { createClient(expRoom, { rank: 10 + i }); }
      expRoom.reassignMatchGroups();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.strictEqual(1, (expRoom as any).activeReservations.length);
      assert.ok(lastMessage(expRoom.clients[0] as any, "seat"));

      // next sweep: reservation is expired → rollback
      expRoom.reassignMatchGroups();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.strictEqual(0, (expRoom as any).activeReservations.length);
      assert.strictEqual(4, releaseCalls[0]?.length);
      assert.deepStrictEqual(disposeCalls, ["r1"]);

      const queued = expRoom.clients.filter((c) => (c as any).userData.group?.reservation === undefined);
      assert.strictEqual(4, queued.length);
    });

    it("transfers the reservation when one unconfirmed client leaves", async () => {
      const trRoom = new QueueRoom();
      trRoom.onCreate({ matchRoomName: "my_room" });

      const created: any = {
        name: "my_room", roomId: "r2", processId: "p-test",
        clients: 0, maxClients: 4, locked: false, private: false,
      };
      (trRoom as any).onGroupReady = async () => created;
      (trRoom as any).reserveSeats = async (_r: any, data: any[]) => data.map(() => true);

      const releaseCalls: string[][] = [];
      (trRoom as any).releaseSeats = async (_r: any, sessionIds: string[]) => {
        releaseCalls.push(sessionIds);
        return sessionIds.map(() => true);
      };

      const clients: any[] = [];
      for (let i = 0; i < 4; i++) { clients.push(createClient(trRoom, { rank: 10 + i })); }
      trRoom.reassignMatchGroups();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.strictEqual(1, (trRoom as any).activeReservations.length);

      clients[0].leave(); // disconnects without confirming
      await new Promise((resolve) => setTimeout(resolve, 20));

      // seat was released for that one session...
      assert.deepStrictEqual(releaseCalls[0], [clients[0].sessionId]);
      // ...but the reservation survives for the other three
      assert.strictEqual(1, (trRoom as any).activeReservations.length);
      assert.strictEqual(3, (trRoom as any).activeReservations[0].sessionIds.length);
    });

    it("never lets an unconfirmed group hold seats past reservationTimeoutMs", async () => {
      const bounded = new QueueRoom();
      bounded.onCreate({
        matchRoomName: "my_room",
        maxWaitingCycles: 5,
        maxWaitingCyclesForPriority: 1,
        allowIncompleteGroups: true,
      });
      (bounded as any).seatReservationGraceTime = 0;
      (bounded as any).seatReservationTimeout = 0.05; // 50ms window

      const created: any = {
        name: "my_room", roomId: "r3", processId: "p-test",
        clients: 0, maxClients: 4, locked: false, private: false,
      };
      (bounded as any).onGroupReady = async () => created;
      (bounded as any).reserveSeats = async (_r: any, data: any[]) => data.map(() => true);
      (bounded as any).releaseSeats = async (_r: any, s: string[]) => s.map(() => true);
      (bounded as any).disposeEmptyRoom = async () => true;

      // 3 long-waiting players (incomplete group) — dispatch via priority
      for (let i = 0; i < 3; i++) {
        const c = createClient(bounded, { rank: 10 + i });
        c.userData.currentCycle = 10;
      }
      bounded.reassignMatchGroups();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(1, (bounded as any).activeReservations.length);

      // well beyond the 50ms window, after another sweep:
      await new Promise((resolve) => setTimeout(resolve, 120));
      bounded.reassignMatchGroups();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // seats reclaimed even though nobody confirmed; clients still queued
      assert.strictEqual(0, (bounded as any).activeReservations.length);
      assert.strictEqual(3, bounded.clients.length);
    });
  });

  describe("team size guard", () => {
    it("skips a team chunk that would overflow maxPlayers instead of merging it", () => {
      for (const key in clientMessages) { delete clientMessages[key]; }

      const teamRoom = new QueueRoom();
      teamRoom.onCreate({ matchRoomName: "my_room", maxPlayers: 4, maxTeamSize: 3 });
      teamRoom.processGroupsReady = () => undefined;

      // two 3-man teams: only one chunk can fit a 4-seat group
      for (let i = 0; i < 3; i++) { createClient(teamRoom, { rank: 10, teamId: "A" }); }
      for (let i = 0; i < 3; i++) { createClient(teamRoom, { rank: 10, teamId: "B" }); }

      teamRoom.reassignMatchGroups();

      for (const g of teamRoom.groups) {
        assert.ok(g.clients.length <= 4, "group must not exceed maxPlayers");
        assert.notStrictEqual(g.ready, true);
      }

      const skipped = teamRoom.clients.find((c) =>
        (c as any).userData.status?.reason === QueueReason.TEAM_TOO_LARGE);
      assert.ok(skipped, "overflowing team members should report TEAM_TOO_LARGE");
    });
  });

  describe("Integration Test", () => {
    it("should create a queue room", () => {
      const gameServer = defineServer({
        rooms: {
          ranked: defineRoom(QueueRoom, { matchRoomName: "" }),
        },
      })
    });
  });
});
