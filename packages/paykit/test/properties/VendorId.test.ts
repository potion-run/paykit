import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { encodeVendorPart } from "../../src/VendorId.ts";
import { assertProperty } from "../support/Property.ts";

/** The alphabet a Stripe lookup key and a Polar name both accept. */
const SAFE = /^(?:[A-Za-z0-9-]|_[0-9a-f]+_)*$/;

const Part = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(32)),
);

const Pair = Schema.Struct({ left: Part, right: Part });

describe("vendor identity parts", () => {
  /**
   * A vendor part is the only thing keeping two tiers' lookup keys apart. The
   * encoding has to be injective — otherwise one tier's checkout resolves the
   * other's price — and it has to stay inside the alphabet the vendor accepts,
   * with the `:` separator escaped so no part can forge a different key.
   */
  it.effect("is injective and never carries the key separator", () =>
    assertProperty(
      Arbitrary.schema(Pair),
      ({ left, right }) => {
        const encoded = encodeVendorPart(left);
        if (!SAFE.test(encoded)) return false;
        if (encoded.includes(":")) return false;
        if (left !== right && encoded === encodeVendorPart(right)) return false;
        // Encoding is a function of the value, not of the call.
        return encodeVendorPart(left) === encoded;
      },
      { runs: 200, size: 30 },
    ),
  );

  it.effect("keeps a stage and a tier pair apart however they spell the separator", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({ stage: Part, tier: Part, otherStage: Part, otherTier: Part }),
      ),
      ({ stage, tier, otherStage, otherTier }) => {
        const key = (stageId: string, tierId: string) =>
          `paykit:${encodeVendorPart(stageId)}:${encodeVendorPart(tierId)}`;
        const same = stage === otherStage && tier === otherTier;
        return (key(stage, tier) === key(otherStage, otherTier)) === same;
      },
      { runs: 120, size: 24 },
    ),
  );
});
