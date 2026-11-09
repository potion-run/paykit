import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { billing } from "../billing.atoms.ts";

export const Route = createFileRoute("/")({ component: Home });

/**
 * What `/bootstrap` answers: the account the cookie now names, or why it could
 * not be minted. Decoded rather than asserted, so a body that is not this shape
 * is a visible failure instead of an `undefined` three frames later.
 */
const BootstrapBody = Schema.Struct({
  account: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

/**
 * The page. `/bootstrap` is the demo's one server operation: it gives the
 * visitor a free standing and returns the account id the cookie now names. From
 * there, everything is an atom.
 */
function Home() {
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/bootstrap", { method: "POST" })
      .then(async (response) => {
        const body = Option.getOrUndefined(
          Schema.decodeUnknownOption(BootstrapBody)(await response.json()),
        );

        if (!response.ok || body?.account === undefined) {
          throw new Error(body?.error ?? `bootstrap failed: ${response.status}`);
        }

        if (live) setAccount(body.account);
      })
      .catch((cause: unknown) => {
        if (live) setError(String(cause));
      });

    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="page">
      <header>
        <p className="eyebrow">paykit · Effect Atom · TanStack Start</p>
        <h1>Billing the page can subscribe to.</h1>
        <p className="lede">
          One tenant Api, one atom runtime. Every command invalidates the account&apos;s reactivity
          key, so the entitlement view refreshes without a manual <code>refresh</code>.
        </p>
      </header>

      {error !== null ? <p className="error">{error}</p> : null}
      {account === null ? (
        <p className="muted">Connecting to the account…</p>
      ) : (
        <Usage account={account} />
      )}
    </main>
  );
}

function Usage({ account }: Readonly<{ account: string }>) {
  const entitlementsAtom = billing.entitlements(account);
  const entitlements = useAtomValue(entitlementsAtom);
  const refresh = useAtomRefresh(entitlementsAtom);

  const trackUsage = useAtomSet(billing.trackUsage(account), { mode: "promise" });
  const check = useAtomSet(billing.check(account), { mode: "promise" });
  const cancel = useAtomSet(billing.scheduleCancellation(account), { mode: "promise" });
  const resume = useAtomSet(billing.resume(account), { mode: "promise" });

  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  const view = AsyncResult.isSuccess(entitlements) ? entitlements.value : null;

  const problem = AsyncResult.isFailure(entitlements)
    ? String(Cause.squash(entitlements.cause))
    : null;

  const messages = view?.features.messages;

  const run = (label: string, action: () => Promise<unknown>) => {
    setNotice(`${label}…`);
    action()
      .then(() => setNotice(`${label}. The account key refreshed the view.`))
      .catch((cause: unknown) => setNotice(`${label} failed: ${String(cause)}`));
  };

  return (
    <section className="panel">
      <div className="row">
        <div>
          <p className="label">Account</p>
          <p className="value mono">{account}</p>
        </div>
        <div>
          <p className="label">Stream</p>
          <p className="value">{entitlements.waiting ? "refreshing" : "live"}</p>
        </div>
        <div>
          <p className="label">Tier</p>
          <p className="value">{view?.tier ?? "—"}</p>
        </div>
        <div>
          <p className="label">Standing</p>
          <p className="value">{view?.standing ?? "—"}</p>
        </div>
      </div>

      {problem !== null ? <p className="error">{problem}</p> : null}

      <div className="feature">
        <p className="label">messages</p>
        {messages === undefined ? (
          <p className="muted">No standing yet.</p>
        ) : (
          <>
            <p className="remaining">
              {messages.remaining === null ? "unlimited" : messages.remaining}
              <span className="unit"> left</span>
            </p>
            <p className="muted">
              {messages.used} used of {messages.included ?? "no count"} · {messages.reserved}{" "}
              reserved · {view?.credits ?? 0} credits
            </p>
          </>
        )}
      </div>

      <div className="actions">
        <button
          type="button"
          onClick={() =>
            run("Tracked 10 messages", () =>
              trackUsage({
                featureId: "messages",
                value: 10,
                idempotencyKey: crypto.randomUUID(),
              }),
            )
          }
        >
          Track 10 messages
        </button>
        <button
          type="button"
          onClick={() => {
            setNotice("Checking 25 messages…");
            check({ featureId: "messages", requiredBalance: 25 })
              .then((result) => {
                setAnswer(
                  `allowed: ${result.allowed} · remaining: ${String(result.balance.remaining)} · standing: ${result.standing}`,
                );
                setNotice("Checked 25 messages.");
              })
              .catch((cause: unknown) => setNotice(`Check failed: ${String(cause)}`));
          }}
        >
          Check 25
        </button>
        <button
          type="button"
          onClick={() =>
            run("Scheduled cancellation", () => cancel({ dedupeKey: crypto.randomUUID() }))
          }
        >
          Cancel at period end
        </button>
        <button
          type="button"
          onClick={() => run("Resumed", () => resume({ dedupeKey: crypto.randomUUID() }))}
        >
          Resume
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            refresh();
            setNotice("Refreshed by hand. A command would have done this for you.");
          }}
        >
          Refresh
        </button>
      </div>

      {notice !== null ? <p className="notice">{notice}</p> : null}
      {answer !== null ? <p className="answer mono">{answer}</p> : null}
    </section>
  );
}
