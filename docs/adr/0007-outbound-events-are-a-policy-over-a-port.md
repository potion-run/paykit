# 0007 — Outbound events are a policy over a delivery port

**Status:** accepted

## Context

The log is the source of truth, and `AccountEvents` already exposes every committed event per
account. An app that reacts to "this account upgraded" has to poll that stream. ADR 0001 §Slice 3
names outbound events as the push edge that removes the poll, "sign and retry like the inbound edge,
reversed".

The inbound edge is a binding (`Webhooks`) because it receives an HTTP request. The outbound edge is
the opposite: the model owns the event and the signature, while the deployment owns the transport.
Putting HTTP into the model would make `decide`'s host depend on `fetch`, give every deployment the
same retry policy, and make the edge untestable without a network.

## Decision

`OutboundEvents` is a `Domain.Policy` on every `Subscription` event. It reads the optional
`Outbound` service, which carries:

- `endpoints` — `{ url, secret }` pairs, secret as `Redacted`;
- `deliver(request)` — the app's transport, given a signed body and the headers to send.

The policy sends one request per endpoint and event:

| Header | Value |
| --- | --- |
| `x-paykit-signature` | `t=<epoch millis>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` |
| `x-paykit-idempotency-key` | `<account>:<event seq>` |
| `x-paykit-event` | the event tag |

The body is `{ account, event, envelope }` as JSON. A transport failure is retried inside the policy
with an exponential schedule, then left to the platform's at-least-once redelivery. The key is the
same on every attempt, so the receiver dedupes both the retry and a replay after a crash. A
deployment that does not provide `Outbound` gets a no-op policy; the model does not require it.

## Consequences

- **At-least-once, not exactly-once.** A crash after the send and before the policy's delivery row
  is written sends the same request again. The idempotency key is the contract; a receiver that
  ignores it sees duplicates.
- **The app owns HTTP.** A Worker, a queue or a test provides `deliver`; paykit never imports a
  transport. `Outbound` is the same kind of port as `Payments`.
- **Every event is pushed.** A receiver filters by `x-paykit-event` or the body. Per-endpoint filters
  and a durable outbox are additive later; the key and the envelope are already in the body.
- **A missing endpoint is a no-op, not a rejection.** An app that has not configured push does not
  pay for a policy failure on every commit.
- **A secret is deployment config.** A rotation is a new `Outbound` layer; the log does not carry it.

## Alternatives considered

- **Make the app poll `AccountEvents`.** Rejected: that is the problem the slice exists to remove.
- **Send HTTP from the policy.** Rejected: it puts a transport in the model host, hides retries in
  one implementation, and cannot be tested without a network.
- **Write an outbox table and a dispatcher.** Rejected for now: the policy's delivery row plus the
  idempotency key already give at-least-once, and a durable replay survives only a load balancer,
  not a receiver's own outage. An outbox is the next step when an endpoint needs a backlog.
- **One request per event with no signature.** Rejected: an unsigned push is indistinguishable from
  an attacker who knows the endpoint URL.
