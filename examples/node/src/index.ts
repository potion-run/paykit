import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import { program } from "./Server.ts";

/**
 * A Node process, not a Worker: `NodeRuntime.runMain` installs the Node
 * services, runs the program, and exits non-zero when it fails. `serve` never
 * returns while the server is listening, so the process stays up until a
 * signal closes the scope.
 */
NodeRuntime.runMain(Effect.scoped(program));
