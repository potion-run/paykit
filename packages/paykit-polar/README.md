# @potion.run/paykit-polar

[Polar](https://polar.sh) as a provider for [`@potion.run/paykit`](https://www.npmjs.com/package/@potion.run/paykit).

`PolarBilling` provisions the products, meters and prices a paykit catalog describes, and `Polar({ ... })` is the runtime provider the Worker uses for checkout, portal, charges and webhooks. The money plane stays behind the `Payments` port; the model never reads Polar.

```sh
pnpm add @potion.run/paykit @potion.run/paykit-polar alchemy effect
```

```ts
import { Paykit } from "@potion.run/paykit";
import { PolarBilling } from "@potion.run/paykit-polar";

const polar = yield* PolarBilling("Polar", {
  ...billing,
  accessToken: process.env.POLAR_ACCESS_TOKEN!,
  server: "sandbox",
});
```

Read the [paykit README](https://www.npmjs.com/package/@potion.run/paykit) and the [billing surface](https://github.com/potion-run/paykit/blob/main/docs/BILLING-SURFACE.md).
