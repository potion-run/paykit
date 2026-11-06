import { allowance as allowanceOf, grant as grantOf, type Allowance } from "../../src/Allowance.ts";
import { feature as featureOf, type Feature } from "../../src/Feature.ts";
import { tier as tierOf, type Tier } from "../../src/Tier.ts";

/**
 * Constructors without their compile-time guards, for a test that deliberately
 * builds a catalog the validator must refuse.
 *
 * The public constructors make these shapes editor errors. The runtime
 * validator is still the authority for a catalog that arrives as JSON, from a
 * JavaScript caller, or from an older build, so its tests reach it through
 * here rather than weakening the public types.
 */
export const rawFeature = (input: unknown): Feature => featureOf(input as never);

export const rawAllowance = (feature: Feature, input: unknown): Allowance =>
  allowanceOf(feature, input as never);

export const rawGrant = (feature: Feature): Allowance => grantOf(feature as never);

export const rawTier = (input: unknown): Tier => tierOf(input as never);
