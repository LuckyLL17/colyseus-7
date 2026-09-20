import assert from "assert";
import { Room, SchemaSerializer, matchMaker, initializeRoomCache } from "@colyseus/core";
import { Schema } from "@colyseus/schema";
import sinon from "sinon";

describe("Room", () => {
  class State extends Schema { }
  class MyRoom extends Room {
    onCreate() { this.setState(new State()); }
    onMessage() { }
  }

  describe("SchemaSerializer", () => {

    it("setState() should select correct serializer", () => {
      const room = new MyRoom()
      room['__init']();
      room.onCreate();

      assert.ok(room['_serializer'] instanceof SchemaSerializer);
    });

  });


  describe("autoDispose", () => {
    it("should initialize with correct value", () => {
      class MyRoom1 extends Room {
        autoDispose = false;
      }

      const room1 = new MyRoom1();
      room1['__init']();
      assert.strictEqual(false, room1.autoDispose);
      assert.strictEqual(undefined, room1['_autoDisposeTimeout']);

      class MyRoom2 extends Room {
        autoDispose = true;
      }

      const room2 = new MyRoom2();
      room2['__init']();
      assert.strictEqual(true, room2.autoDispose);
      assert.strictEqual(false, room2['_autoDisposeTimeout']['_destroyed']);
    });

    it("autoDispose setter should reset the autoDispose timeout", () => {
      const room = new MyRoom();
      room['__init']();

      // @ts-ignore
      const resetAutoDisposeTimeoutSpy = sinon.spy(room, 'resetAutoDisposeTimeout');

      room.autoDispose = false;
      room.autoDispose = true;

      sinon.assert.callCount(resetAutoDisposeTimeoutSpy, 2);
    });
  });

  describe("patchRate", () => {
    it("should initialize with correct value", () => {
      const room = new MyRoom();
      room['__init']();

      assert.strictEqual(50, room.patchRate);
    });

    //
    // See: https://github.com/colyseus/colyseus/issues/869
    //
    it("setting patchRate to zero shouldn't interfere with clock's setTimeout", async () => {
      const room = new MyRoom();
      room['__init']();

      let called = 0;
      room.clock.setTimeout(() => called++, 10);

      room.patchRate = 0;

      await new Promise(resolve => setTimeout(resolve, 20));
      assert.strictEqual(1, called);
    });

    it("setting patchRate to zero shouldn't interfere with clock's setInterval", async () => {
      const room = new MyRoom();
      room['__init']();

      let called = 0;
      room.clock.setInterval(() => called++, 10);

      room.patchRate = 0;

      await new Promise(resolve => setTimeout(resolve, 60));
      assert.ok(called >= 3, `Expected at least 3 calls, got ${called}`);
    });

  });


  describe("seat reservation atomicity", () => {
    let seatRoom: Room;

    function reserve(sessionIds: string[]) {
      return (seatRoom as any)["_reserveMultipleSeats"](
        sessionIds,
        sessionIds.map(() => ({})),
        sessionIds.map(() => undefined),
      );
    }

    beforeEach(async () => {
      await matchMaker.setup();
      seatRoom = new Room();
      (seatRoom as any)["__init"]();
      seatRoom.maxClients = 4;
      (seatRoom as any).roomId = "atomic-seat-room";
      (seatRoom as any).roomName = "test";
      (seatRoom as any)["_listing"] = initializeRoomCache({ name: "test", processId: matchMaker.processId });
      (seatRoom as any)["_listing"].roomId = "atomic-seat-room";
      (seatRoom as any)["_listing"].maxClients = 4;
    });

    it("rejects the whole batch atomically when capacity is insufficient", async () => {
      assert.deepStrictEqual(await reserve(["a", "b", "c"]), [true, true, true]);
      assert.strictEqual(3, Object.keys((seatRoom as any)["_reservedSeats"]).length);

      // only one seat free but two requested → no partial reservation
      assert.deepStrictEqual(await reserve(["d", "e"]), [false, false]);
      assert.strictEqual(3, Object.keys((seatRoom as any)["_reservedSeats"]).length);
      assert.strictEqual(undefined, (seatRoom as any)["_reservedSeats"].d);
      assert.strictEqual(undefined, (seatRoom as any)["_reservedSeats"].e);

      // the last free seat can still be taken
      assert.deepStrictEqual(await reserve(["f"]), [true]);
      assert.strictEqual(4, Object.keys((seatRoom as any)["_reservedSeats"]).length);
    });

    it("releases only fresh (unconsumed) seats", async () => {
      await reserve(["a", "b"]);
      // "a" is already being consumed by a joining client
      (seatRoom as any)["_reservedSeats"].a[2] = true;

      const results = await (seatRoom as any)["_releaseSeats"](["a", "b"]);
      assert.deepStrictEqual(results, [false, true]);
      assert.ok((seatRoom as any)["_reservedSeats"].a !== undefined);
      assert.strictEqual(undefined, (seatRoom as any)["_reservedSeats"].b);
    });

    it("disposes immediately once all seats are released", async () => {
      await reserve(["a"]);
      assert.strictEqual(false, (seatRoom as any)["_disposeIfEmptyNow"]());
      await (seatRoom as any)["_releaseSeats"](["a"]);
      assert.strictEqual(true, (seatRoom as any)["_disposeIfEmptyNow"]());
    });
  });

});

