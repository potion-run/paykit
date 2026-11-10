import { describe, expect, it } from "@alchemy.run/test";
import * as Redacted from "effect/Redacted";
import {
  POLAR_API_BASE_URL_ENV,
  POLAR_API_KEY_ENV,
  POLAR_AUTH_PROVIDER_NAME,
} from "../src/AuthProvider.ts";
import Contributions from "../src/Contributions.ts";
import { fromAuthProvider } from "../src/Credentials.ts";
import { distilledPolarClient } from "../src/PolarClient.ts";

describe("the deploy's Polar credentials", () => {
  it("registers a contributor Alchemy can discover", () => {
    expect(Contributions.name).toBe("polar");
    expect(Contributions.auth).toBeDefined();
  });

  it("names the environment contract the AuthProvider reads", () => {
    expect(POLAR_AUTH_PROVIDER_NAME).toBe("Polar");
    expect(POLAR_API_KEY_ENV).toBe("POLAR_API_KEY");
    expect(POLAR_API_BASE_URL_ENV).toBe("POLAR_API_BASE_URL");
  });

  it("builds the runtime client and the deploy credentials layer", () => {
    const client = distilledPolarClient({ accessToken: Redacted.make("polar_test") });

    expect(typeof client.createCheckoutSession).toBe("function");
    expect(typeof client.createCustomerSession).toBe("function");
    expect(typeof client.createInvoice).toBe("function");
    expect(fromAuthProvider()).toBeDefined();
  });
});
