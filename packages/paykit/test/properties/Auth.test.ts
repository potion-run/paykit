import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { mayActOn } from "../../src/Auth/Actor.ts";
import {
  ACTOR_HEADER,
  KIND_HEADER,
  accountFromHeaders,
  actorFromHeaders,
} from "../../src/Auth/FromHeaders.ts";
import { assertProperty } from "../support/Property.ts";

const ActorKind = Schema.Literals(["account", "admin", "system"]);
const Id = Schema.Literals(["acct_1", "acct_2", "ops", "svc"]);

describe("authorization", () => {
  it.effect("an account acts only for itself, and an operator or the system acts for any", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          kind: ActorKind,
          id: Id,
          target: Id,
        }),
      ),
      ({ kind, id, target }) => {
        const actor = { kind, id };
        const allowed = mayActOn(actor, target);

        return kind === "account" ? allowed === (id === target) : allowed;
      },
      { runs: 80, size: 12 },
    ),
  );

  it.effect("reads back the actor the headers name, and refuses a malformed one", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          kind: Schema.optionalKey(ActorKind),
          id: Schema.optionalKey(Id),
        }),
      ),
      ({ kind, id }) => {
        const headers: Record<string, string> = {};

        if (kind !== undefined) headers[KIND_HEADER] = kind;

        if (id !== undefined) headers[ACTOR_HEADER] = id;
        const actor = actorFromHeaders(headers);

        if (id === undefined) return actor === null;

        if (actor === null) return false;

        // Kind defaults to `account`; an explicit, valid kind survives.
        return actor.id === id && actor.kind === (kind ?? "account");
      },
      { runs: 80, size: 12 },
    ),
  );

  it("refuses a kind it does not know", () => {
    expect(actorFromHeaders({ [ACTOR_HEADER]: "acct_1", [KIND_HEADER]: "superuser" })).toBe(null);
  });

  it("reduces the header pair to the account a handler's checkout acts for", () => {
    expect(accountFromHeaders({ [ACTOR_HEADER]: "acct_1", [KIND_HEADER]: "admin" })).toBe("acct_1");
    expect(accountFromHeaders({})).toBe(null);
    expect(accountFromHeaders({ [ACTOR_HEADER]: "acct_1", [KIND_HEADER]: "superuser" })).toBe(null);
  });
});
