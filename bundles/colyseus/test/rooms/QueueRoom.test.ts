import assert from "assert";
import { QueueRoom, QueueReason, Room, defineRoom, defineServer, generateId, matchMaker, LocalDriver, type Client, type QueueClientStatus } from "../../src/index.ts";
import { DummyRoom, createDummyClient, timeout } from "../utils/index.ts";

const clientMessages: { [sessionId: string]: any[] } = {};

export function createClient(room: Room, clientOptions: any) {
  const sessionId = generateId();
  const client = {
    sessionId,
    send: function (type: string, message: any) {
      if (!clientMessages[sessionId]) { clientMessages[sessionId] = []; }
      clientMessages[sessionId].push({ type, message });
    }
  } as Client;
  room.onJoin!(client, clientOptions);
  room.clients.push(client);
  return client;
}

export function getQueueMessages(client: Client): QueueClientStatus[] {
  return (clientMessages[client.sessionId] || [])
    .filter((entry) => entry.type === "queue")
    .map((entry) => entry.message);
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

      it("should skip teams that do not fit the remaining slots (instead of splitting them)", () => {
        room.maxPlayers = 4;
        room.maxTeamSize = 3;

        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });

        room.reassignMatchGroups();

        // teams of 3 can't be merged into a group of 4 - each team keeps
        // waiting intact on its own group instead of being split.
        assert.strictEqual(2, room.groups.length);
        assert.strictEqual(3, room.groups[0].clients.length);
        assert.strictEqual(3, room.groups[1].clients.length);
        assert.strictEqual(undefined, room.groups[0].ready);
        assert.strictEqual(undefined, room.groups[1].ready);

        // teams are kept intact
        assert.ok(room.groups[0].clients.every((c) => c.userData!.teamId === "A"));
        assert.ok(room.groups[1].clients.every((c) => c.userData!.teamId === "B"));

        // the skipped team is told why it is waiting
        assert.ok(room.groups[1].clients.every((c) => c.userData!.queueReason === QueueReason.TEAM_SIZE_MISMATCH));
      });

      it("should fill a group with multiple smaller teams, skipping the ones that don't fit", () => {
        room.maxPlayers = 4;
        room.maxTeamSize = 2;

        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "A" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });
        createClient(room, { rank: 10, teamId: "B" });

        room.reassignMatchGroups();

        // A(2) + B(2) fill the first group; the remaining B player waits.
        const readyGroups = room.groups.filter(g => g.ready);
        assert.strictEqual(1, readyGroups.length);
        assert.strictEqual(4, readyGroups[0].clients.length);
      });
    });

    describe("matchmaking score", () => {
      it("should compute an explainable score (wait, rank, region)", () => {
        createClient(room, { rank: 10 });
        room.reassignMatchGroups();

        const client = room.clients[0];
        const score = client.userData.lastScore;

        assert.ok(score, "should have a computed score");
        assert.deepStrictEqual(score.weights, { wait: 0.5, rank: 0.3, region: 0.2 });

        // waited 1 cycle out of 10 (maxWaitingCyclesForPriority)
        assert.strictEqual(score.components.wait, 0.1);
        // alone in the group: rank and region are fully compatible
        assert.strictEqual(score.components.rank, 1);
        assert.strictEqual(score.components.region, 1);

        const expectedTotal = 0.1 * 0.5 + 1 * 0.3 + 1 * 0.2;
        assert.ok(Math.abs(score.total - expectedTotal) < 1e-9, `total should be the weighted sum (got ${score.total})`);
      });

      it("wait component should grow as the client waits", () => {
        createClient(room, { rank: 10 });

        room.reassignMatchGroups();
        const client = room.clients[0];
        const firstWait = client.userData.lastScore.components.wait;

        room.reassignMatchGroups();
        room.reassignMatchGroups();
        const laterWait = client.userData.lastScore.components.wait;

        assert.ok(laterWait > firstWait, `wait component should grow (${firstWait} -> ${laterWait})`);
      });

      it("rank component should reflect distance to the group's average rank", () => {
        createClient(room, { rank: 10 });
        createClient(room, { rank: 20 });

        room.reassignMatchGroups();

        const [first, second] = room.clients;
        // group average rank is 15: both clients are equally distant
        assert.strictEqual(first.userData.lastScore.components.rank, second.userData.lastScore.components.rank);
        assert.ok(first.userData.lastScore.components.rank < 1, "rank component should be below 1 for non-identical ranks");
      });

      it("region component should be 0 when the client is in another region", () => {
        createClient(room, { rank: 10, region: "us-east" });
        createClient(room, { rank: 10, region: "eu-west" });

        room.reassignMatchGroups();

        const [first, second] = room.clients;
        assert.strictEqual(first.userData.lastScore.components.region, 1, "first client defines the group region");
        assert.strictEqual(second.userData.lastScore.components.region, 0, "region mismatch should score 0");
        assert.ok(second.userData.lastScore.total < first.userData.lastScore.total);
      });

      it("should use a custom score function when provided", () => {
        (room as any).score = () => 0.42;

        createClient(room, { rank: 10 });
        room.reassignMatchGroups();

        assert.strictEqual(room.clients[0].userData.lastScore.total, 0.42);
      });

      it("should respect custom score weights", () => {
        room.scoreWeights = { wait: 1, rank: 0, region: 0 };

        createClient(room, { rank: 10 });
        room.reassignMatchGroups();

        const score = room.clients[0].userData.lastScore;
        assert.strictEqual(score.total, score.components.wait);
      });
    });

    describe("queue status", () => {
      it("should send queue status on join", () => {
        const client = createClient(room, { rank: 10 });

        const statuses = getQueueMessages(client);
        assert.strictEqual(1, statuses.length);

        const status = statuses[0];
        assert.strictEqual(status.clients, 1);
        assert.strictEqual(status.needed, 3);
        assert.strictEqual(status.reason, QueueReason.WAITING_FOR_PLAYERS);
        assert.strictEqual(status.estimatedWaitMs, null, "not enough information to estimate");
        assert.ok(status.score, "should include the score breakdown");
      });

      it("should report 'waiting_for_compatible_group' when other clients are waiting but incompatible", () => {
        createClient(room, { rank: 10 });
        createClient(room, { rank: 100 });

        room.reassignMatchGroups();

        assert.strictEqual(2, room.groups.length, "incompatible clients should be on separate groups");

        for (const client of room.clients) {
          const status = room.getQueueStatus(client);
          assert.strictEqual(status.reason, QueueReason.WAITING_FOR_COMPATIBLE_GROUP);
        }
      });

      it("should estimate wait time from the observed join rate", () => {
        room.maxPlayers = 4;

        createClient(room, { rank: 10 });
        createClient(room, { rank: 10 });
        room.reassignMatchGroups();

        // 2 joins observed this cycle, 2 more players needed: 1 cycle left
        const status = room.getQueueStatus(room.clients[0]);
        assert.strictEqual(status.estimatedWaitMs, 1000);
      });

      it("estimated wait should never exceed the cycles left until bot-fill (allowIncompleteGroups)", () => {
        room.allowIncompleteGroups = true;
        room.maxWaitingCycles = 5;

        createClient(room, { rank: 10 });
        room.reassignMatchGroups();

        // join rate of 1/cycle suggests 3 more cycles; the bot-fill bound
        // (5 - 1 = 4 cycles) does not lower the estimate further.
        const status = room.getQueueStatus(room.clients[0]);
        assert.strictEqual(status.estimatedWaitMs, 3000);
      });

      it("estimated wait should be bounded by bot-fill when joins are scarce", () => {
        room.allowIncompleteGroups = true;
        room.maxWaitingCycles = 5;

        createClient(room, { rank: 10 });
        room.reassignMatchGroups();
        room.reassignMatchGroups();

        // join rate of 0.5/cycle suggests 6 more cycles; bounded by 5 - 2 = 3.
        const status = room.getQueueStatus(room.clients[0]);
        assert.strictEqual(status.estimatedWaitMs, 3000);
      });

      it("getQueueStatus() should reflect the client's group", () => {
        createClient(room, { rank: 10 });
        createClient(room, { rank: 20 });

        room.reassignMatchGroups();

        const status = room.getQueueStatus(room.clients[0]);
        assert.strictEqual(status.clients, 2);
        assert.strictEqual(status.needed, 2);
        assert.strictEqual(status.reason, QueueReason.WAITING_FOR_PLAYERS);
      });
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

  describe("Seat reservation lifecycle", () => {
    let driver: LocalDriver;

    class Room1Client extends Room {
      maxClients = 1;
      onCreate() { }
      onJoin() { }
      onLeave() { }
    }

    class BrokenRoom extends Room {
      onCreate() { throw new Error("broken onCreate"); }
    }

    before(async () => {
      driver = new LocalDriver();
      await matchMaker.setup(undefined, driver);

      matchMaker.defineRoomType("match", DummyRoom);
      matchMaker.defineRoomType("match_tiny", Room1Client);
      matchMaker.defineRoomType("match_broken", BrokenRoom);

      matchMaker.defineRoomType("queue", QueueRoom, {
        matchRoomName: "match",
        maxPlayers: 2,
        maxConfirmationCycles: 2,
      });

      matchMaker.defineRoomType("queue_tiny_match", QueueRoom, {
        matchRoomName: "match_tiny",
        maxPlayers: 2,
        maxConfirmationCycles: 2,
      });

      matchMaker.defineRoomType("queue_broken_match", QueueRoom, {
        matchRoomName: "match_broken",
        maxPlayers: 2,
        maxConfirmationCycles: 2,
        maxReservationRetries: 1,
      });
    });

    beforeEach(async () => {
      await driver.clear();
      await matchMaker.setup(undefined, driver);
      await matchMaker.accept();
    });

    afterEach(async () => await matchMaker.gracefullyShutdown());

    after(async () => {
      await driver.clear();
      await driver.shutdown();
    });

    /**
     * Join a client into a queue room, returning the queue room and the client.
     * The queue room's automatic cycle is stopped so tests can drive
     * `reassignMatchGroups()` manually.
     */
    async function joinQueue(roomName: string, options: any) {
      const seat = await matchMaker.joinOrCreate(roomName, options);
      const queueRoom = matchMaker.getLocalRoomById(seat.roomId) as QueueRoom;
      queueRoom.setTimestep(undefined); // drive cycles manually

      const client = createDummyClient(seat, options);
      await client.confirmJoinRoom(queueRoom);

      return { queueRoom, client };
    }

    it("should reserve seats and track the group until all clients confirm", async () => {
      const { queueRoom, client: client1 } = await joinQueue("queue", { rank: 10 });
      const { client: client2 } = await joinQueue("queue", { rank: 10 });

      queueRoom.reassignMatchGroups();
      await timeout(100);

      // group is ready and waiting for confirmations
      assert.strictEqual(1, queueRoom.pendingConfirmation.length);
      const group = queueRoom.pendingConfirmation[0];

      const matchRoom = matchMaker.getLocalRoomById(group.reservation!.room.roomId);
      assert.ok(matchRoom.hasReservedSeat(client1.sessionId), "seat reserved for client1");
      assert.ok(matchRoom.hasReservedSeat(client2.sessionId), "seat reserved for client2");

      // both clients confirm
      queueRoom.messages.confirm(client1, null);
      queueRoom.messages.confirm(client2, null);
      await timeout(50);

      queueRoom.reassignMatchGroups();

      assert.strictEqual(0, queueRoom.pendingConfirmation.length, "group is forgotten once all clients confirmed");
    });

    it("should release seats and re-queue clients that never confirm", async () => {
      const { queueRoom, client: client1 } = await joinQueue("queue", { rank: 10 });
      const { client: client2 } = await joinQueue("queue", { rank: 10 });

      queueRoom.reassignMatchGroups();
      await timeout(100);

      assert.strictEqual(1, queueRoom.pendingConfirmation.length);
      const firstGroup = queueRoom.pendingConfirmation[0];
      const matchRoom = matchMaker.getLocalRoomById(firstGroup.reservation!.room.roomId);
      assert.ok(matchRoom.hasReservedSeat(client1.sessionId));

      // cycle through the confirmation window without any confirmation
      queueRoom.reassignMatchGroups();
      await timeout(50);
      queueRoom.reassignMatchGroups();
      await timeout(100);

      assert.ok(!queueRoom.pendingConfirmation.includes(firstGroup), "original group should time out");
      assert.ok(!matchRoom.hasReservedSeat(client1.sessionId), "seat of unconfirmed client1 should be released");
      assert.ok(!matchRoom.hasReservedSeat(client2.sessionId), "seat of unconfirmed client2 should be released");

      // clients are re-queued (not disconnected) and may form a new group
      assert.strictEqual(2, queueRoom.clients.length);
      assert.strictEqual(1, (client1 as any).userData.reservationRetries);
      assert.strictEqual(1, (client2 as any).userData.reservationRetries);
    });

    it("should release the seat of a client that leaves a ready group", async () => {
      const { queueRoom, client: client1 } = await joinQueue("queue", { rank: 10 });
      const { client: client2 } = await joinQueue("queue", { rank: 10 });

      queueRoom.reassignMatchGroups();
      await timeout(100);

      const matchRoom = matchMaker.getLocalRoomById(queueRoom.pendingConfirmation[0].reservation!.room.roomId);
      assert.ok(matchRoom.hasReservedSeat(client1.sessionId));

      // client1 disconnects without confirming
      client1.close();
      await timeout(100);

      assert.ok(!matchRoom.hasReservedSeat(client1.sessionId), "seat of disconnected client should be released");
      assert.ok(matchRoom.hasReservedSeat(client2.sessionId), "seat of remaining client is kept");
    });

    it("should re-queue clients when room creation fails, and drop them after maxReservationRetries", async () => {
      const { queueRoom, client: client1 } = await joinQueue("queue_broken_match", { rank: 10 });
      const { client: client2 } = await joinQueue("queue_broken_match", { rank: 10 });

      // first attempt fails: clients are re-queued
      queueRoom.reassignMatchGroups();
      await timeout(100);

      assert.strictEqual(2, queueRoom.clients.length, "clients should stay in the queue");
      assert.strictEqual(1, (client1 as any).userData.reservationRetries);
      assert.strictEqual(undefined, (client1 as any).userData.group, "client should be re-queued");

      // second attempt exceeds maxReservationRetries (1): clients are dropped
      queueRoom.reassignMatchGroups();
      await timeout(100);

      assert.strictEqual(0, queueRoom.clients.length, "clients should be dropped after maxReservationRetries");
    });

    it("should dispose the created room when the seat reservation fails", async () => {
      const { queueRoom } = await joinQueue("queue_tiny_match", { rank: 10 });
      await joinQueue("queue_tiny_match", { rank: 10 });

      queueRoom.reassignMatchGroups();
      await timeout(100);

      // the group of 2 does not fit on a 1-client room: reservation fails,
      // the created room is rolled back (disposed) and clients re-queued.
      const matchRooms = await matchMaker.query({ name: "match_tiny" });
      assert.strictEqual(0, matchRooms.length, "created room should have been disposed");

      assert.strictEqual(2, queueRoom.clients.length, "clients should stay in the queue");
    });

    it("should expose queue stats through matchMaker.getQueueStats()", async () => {
      const { queueRoom } = await joinQueue("queue", { rank: 10 });
      await joinQueue("queue", { rank: 10 });

      queueRoom.reassignMatchGroups();
      await timeout(100);

      const stats = await matchMaker.getQueueStats("queue");
      assert.strictEqual(1, stats.length);
      assert.strictEqual(2, stats[0].clients);
      assert.strictEqual(stats[0].roomId, queueRoom.roomId);
      assert.strictEqual(typeof stats[0].averageWaitCycles, "number");
      assert.strictEqual(typeof stats[0].estimatedWaitMs, "number");
      assert.ok(stats[0].updatedAt > 0);
    });

    it("should keep supporting joins with only the queue name (no options)", async () => {
      const seat = await matchMaker.joinOrCreate("queue");
      const queueRoom = matchMaker.getLocalRoomById(seat.roomId) as QueueRoom;
      queueRoom.setTimestep(undefined);

      const client = createDummyClient(seat);
      await client.confirmJoinRoom(queueRoom);

      queueRoom.reassignMatchGroups();
      await timeout(50);

      assert.strictEqual(1, queueRoom.clients.length);
      assert.ok((client as any).userData, "client should have queue data");
    });
  });
});
