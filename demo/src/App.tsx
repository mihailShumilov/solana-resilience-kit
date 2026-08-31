import { useEffect, useReducer, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { VersionedTransaction } from "@solana/web3.js";
import { Docs } from "./Docs";
import {
  Lab,
  type DevnetView,
  type EndpointView,
  type LabState,
  type LogLine,
  type MetricsView,
  type Network,
  type PipelineStep,
  type Scenario,
  type ScenarioInfo,
  type Tally,
} from "./lab";

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "healthy", label: "healthy" },
  { id: "drop", label: "drop" },
  { id: "429", label: "429" },
  { id: "lag", label: "lag" },
  { id: "behind", label: "behind" },
  { id: "jito-fail", label: "jito-fail" },
  { id: "congestion", label: "congestion" },
];

type Theme = "dark" | "light";
type View = "lab" | "docs";

export function App() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const labRef = useRef<Lab | null>(null);
  if (labRef.current === null) labRef.current = new Lab(() => force());
  const lab = labRef.current;
  const state = lab.getState();
  const devnet = state.network === "devnet";

  const [view, setView] = useState<View>("lab");
  const labView = view === "lab";

  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.getAttribute("data-theme") as Theme) ?? "dark",
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Bridge the standard wallet-adapter into the Lab: address + signer, or null.
  const { publicKey, connected, signTransaction } = useWallet();
  useEffect(() => {
    if (connected && publicKey && signTransaction) {
      const sign = signTransaction;
      lab.setWallet({
        address: publicKey.toBase58(),
        signTransaction: (tx: VersionedTransaction) => sign(tx),
      });
    } else {
      lab.setWallet(null);
    }
  }, [connected, publicKey, signTransaction, lab]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <h1>RPC Resilience Lab</h1>
          <span className="tag">solana-resilience-kit · v{__SDK_VERSION__}</span>
        </div>
        <div className="topbar-right">
          {labView && <NetworkSwitch network={state.network} disabled={state.running} onChange={(n) => lab.setNetwork(n)} />}
          {labView && devnet && <WalletMultiButton />}
          {labView && !devnet && <Clock slot={state.slot} />}
          <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "◐ light" : "◑ dark"}
          </button>
        </div>
      </header>

      <nav className="mainnav">
        <button className="mono" data-active={labView} onClick={() => setView("lab")}>
          Lab
        </button>
        <button className="mono" data-active={view === "docs"} onClick={() => setView("docs")}>
          Docs &amp; Examples
        </button>
        <a className="mono" href="/api/" target="_blank" rel="noreferrer">
          API reference ↗
        </a>
      </nav>

      {!labView ? (
        <Docs />
      ) : (
        <>
          <p className="intro">
            The real SDK runs in your browser. In <code>simulation</code> it drives a deterministic Solana
            harness — inject faults, then flip <code>SDK</code> off to see how a naive client fares. In{" "}
            <code>devnet</code> it builds, signs, and lands a real transaction you can open in the explorer.
          </p>

          <ControlDeck lab={lab} state={state} />
          {devnet ? (
            <DevnetPanel lab={lab} dv={state.devnet} />
          ) : (
            <ScenarioExplainer info={state.info} sdkEnabled={state.sdkEnabled} />
          )}

          <div className="grid">
            <div className="col">
              {!devnet && (
                <section className="card">
                  <header>
                    <h2>Endpoints</h2>
                    <span className="meta">block {state.blockHeight.toLocaleString()}</span>
                  </header>
                  <div className="card-body">
                    <div className="endpoints">
                      {state.endpoints.map((ep) => (
                        <EndpointCard key={ep.name} ep={ep} />
                      ))}
                    </div>
                  </div>
                </section>
              )}

              <section className="card">
                <header>
                  <h2>Pipeline</h2>
                  <span className="meta">{state.running ? "running…" : state.sdkEnabled ? "resilient" : "naive baseline"}</span>
                </header>
                <div className="card-body">
                  <Pipeline steps={state.steps} />
                </div>
              </section>
            </div>

            <div className="col">
              <section className="card">
                <header>
                  <h2>Scoreboard &amp; telemetry</h2>
                  <span className="meta">cumulative</span>
                </header>
                <div className="card-body">
                  <MetricsPanel m={state.metrics} comparison={state.comparison} />
                </div>
              </section>

              <section className="card">
                <header>
                  <h2>Event log</h2>
                  <span className="meta">{state.log.length} lines</span>
                </header>
                <EventLog log={state.log} />
              </section>
            </div>
          </div>
        </>
      )}

      <footer className="footer">
        <span>real SDK · {devnet ? "real devnet" : "simulation harness"} · vendor-neutral resilience</span>
        <a href="https://github.com/mihailShumilov/solana-resilience-kit" target="_blank" rel="noreferrer">
          github.com/mihailShumilov/solana-resilience-kit
        </a>
      </footer>
    </div>
  );
}

function NetworkSwitch({ network, disabled, onChange }: { network: Network; disabled: boolean; onChange: (n: Network) => void }) {
  return (
    <div className="net-seg">
      <button data-active={network === "sim"} disabled={disabled} onClick={() => onChange("sim")}>
        simulation
      </button>
      <button data-active={network === "devnet"} disabled={disabled} onClick={() => onChange("devnet")}>
        devnet
      </button>
    </div>
  );
}

function Clock({ slot }: { slot: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="clock mono">
      slot <b>{slot.toLocaleString()}</b> · {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
    </span>
  );
}

function ControlDeck({ lab, state }: { lab: Lab; state: LabState }) {
  const busy = state.running;
  const devnet = state.network === "devnet";
  return (
    <div className="deck" data-sdk={state.sdkEnabled}>
      <div className="field">
        <label>{devnet ? "Fault scenario (simulation only)" : "Fault scenario"}</label>
        <div className="scenarios">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              className="chip mono"
              data-active={!devnet && state.scenario === s.id}
              disabled={busy || devnet}
              onClick={() => void lab.applyScenario(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Library</label>
        <label className="toggle sdk-toggle" data-on={state.sdkEnabled}>
          <input type="checkbox" checked={state.sdkEnabled} disabled={busy} onChange={(e) => lab.setSdkEnabled(e.target.checked)} />
          {state.sdkEnabled ? "SDK on" : "SDK off"}
        </label>
      </div>

      <div className="field">
        <label>Route</label>
        <label className="toggle">
          <input type="checkbox" checked={state.viaJito} disabled={busy || devnet} onChange={(e) => lab.setViaJito(e.target.checked)} />
          via Jito
        </label>
      </div>

      <div className="field">
        <label>Tick speed</label>
        <div className="speed">
          <input type="range" min={60} max={600} step={20} defaultValue={220} onChange={(e) => lab.setSpeed(Number(e.target.value))} />
          <span className="val">{lab.speedMs}ms/{devnet ? "poll" : "slot"}</span>
        </div>
      </div>

      <div className="deck-actions">
        <button className="btn-ghost mono" disabled={busy} onClick={() => lab.reset()}>
          reset
        </button>
        <button
          className="btn-send"
          disabled={busy || (devnet && !state.devnet.connected)}
          onClick={() => void lab.send()}
        >
          {busy
            ? "Sending…"
            : devnet
              ? state.devnet.connected
                ? "Send devnet tx"
                : "Connect wallet first"
              : state.sdkEnabled
                ? "Send transaction"
                : "Send (no SDK)"}
        </button>
      </div>
    </div>
  );
}

function ScenarioExplainer({ info, sdkEnabled }: { info: ScenarioInfo; sdkEnabled: boolean }) {
  return (
    <section className="card explain">
      <header>
        <h2>Scenario · {info.id}</h2>
        <span className="meta">{sdkEnabled ? "SDK engaged" : "SDK bypassed"}</span>
      </header>
      <div className="card-body explain-body">
        <div className="ex-fault">
          <span className="ex-k">Injected fault</span>
          <p>{info.fault}</p>
        </div>
        <div className="ex-cols">
          <div className="ex-col" data-live={!sdkEnabled}>
            <span className="ex-k">Without the kit</span>
            <p>{info.without}</p>
          </div>
          <div className="ex-col" data-live={sdkEnabled}>
            <span className="ex-k">With solana-resilience-kit</span>
            <p>{info.withKit}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DevnetPanel({ lab, dv }: { lab: Lab; dv: DevnetView }) {
  return (
    <section className="card devnet-panel">
      <header>
        <h2>Devnet · real transactions</h2>
        <span className="meta">{dv.connected ? "wallet connected" : "connect a wallet ↗"}</span>
      </header>
      <div className="card-body devnet-grid">
        <p className="warn-note">
          ⚠ Devnet only. Use the <b>Select / Connect Wallet</b> button (top right) to connect, then{" "}
          <b>Send devnet tx</b> — the wallet signs a 0.001 SOL transfer and the SDK lands it on devnet. The recipient is
          fixed (below); flip <code>SDK</code> off to compare against a naive single broadcast.
        </p>

        <div className="kp-meta">
          <span>
            from <b>{dv.address ?? "— not connected —"}</b>
          </span>
          <span>
            balance <b>{dv.loadingBalance ? "…" : dv.balanceSol === null ? "—" : `${dv.balanceSol.toFixed(4)} SOL`}</b>
          </span>
          <span>
            to <b>{dv.recipient}</b>
          </span>
          {dv.connected && (
            <a onClick={() => void lab.refreshBalance()} style={{ cursor: "pointer" }}>
              refresh
            </a>
          )}
          {dv.address && (
            <a href={`https://explorer.solana.com/address/${dv.address}?cluster=devnet`} target="_blank" rel="noreferrer">
              sender ↗
            </a>
          )}
          <a href="https://faucet.solana.com/" target="_blank" rel="noreferrer">
            faucet ↗
          </a>
        </div>

        {dv.explorerUrl && (
          <div className="explorer-link">
            last tx →{" "}
            <a href={dv.explorerUrl} target="_blank" rel="noreferrer">
              {dv.lastSignature}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

function EndpointCard({ ep }: { ep: EndpointView }) {
  return (
    <div className="ep" data-state={ep.state}>
      {ep.routing && <span className="routing">routing</span>}
      <div className="ep-top">
        <span className="ep-name">{ep.name}</span>
        <span className="ep-state">{ep.state}</span>
      </div>
      <div className="ep-readout">
        <div className="ro">
          <span>slot</span>
          <b>{ep.slot === null ? "—" : ep.slot.toLocaleString()}</b>
        </div>
        <div className="ro">
          <span>latency</span>
          <b>{ep.latencyMs > 0 ? `${ep.latencyMs}ms` : "—"}</b>
        </div>
        <div className="ro">
          <span>fails</span>
          <b>{ep.consecutiveFailures}</b>
        </div>
        <div className="ro">
          <span>signal</span>
          <b>{ep.state === "healthy" ? "nominal" : ep.state === "degraded" ? "degraded" : "down"}</b>
        </div>
      </div>
      <div className="ep-faults">
        {ep.faults.length === 0 ? (
          <span className="fault none">no faults</span>
        ) : (
          ep.faults.map((f) => (
            <span key={f} className="fault">
              {f}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function Pipeline({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="pipe">
      {steps.map((s) => (
        <div key={s.id} className="pstep" data-status={s.status}>
          <span className="node" />
          <span className="label">{s.label}</span>
          {s.detail && <span className="detail">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function Scoreboard({ comparison }: { comparison: { sdk: Tally; naive: Tally } }) {
  const Row = ({ label, t, color }: { label: string; t: Tally; color: string }) => {
    const pct = Math.round(t.rate * 100);
    return (
      <div className="score-row">
        <div className="score-head">
          <span className="score-label" style={{ color }}>
            {label}
          </span>
          <span className="score-val">{t.total === 0 ? "— no runs" : `${t.confirmed}/${t.total} landed · ${pct}%`}</span>
        </div>
        <div className="bar">
          <i style={{ width: `${pct}%`, background: color }} />
        </div>
      </div>
    );
  };
  return (
    <div className="scoreboard">
      <Row label="with kit" t={comparison.sdk} color="var(--accent)" />
      <Row label="without kit" t={comparison.naive} color="var(--coral)" />
    </div>
  );
}

function MetricsPanel({ m, comparison }: { m: MetricsView; comparison: { sdk: Tally; naive: Tally } }) {
  return (
    <>
      <div className="sb-label">landing rate — run the same setup with SDK on, then off</div>
      <Scoreboard comparison={comparison} />
      <div className="tiles" style={{ marginTop: 14 }}>
        <div className="tile">
          <div className="k">failovers</div>
          <div className="v">{m.failovers}</div>
        </div>
        <div className="tile">
          <div className="k">rebroadcasts</div>
          <div className="v">{m.rebroadcasts}</div>
        </div>
        <div className="tile">
          <div className="k">expired</div>
          <div className="v" style={{ color: m.expired > 0 ? "var(--coral)" : undefined }}>
            {m.expired}
          </div>
        </div>
        <div className="tile">
          <div className="k">rpc requests</div>
          <div className="v">{m.requests}</div>
        </div>
      </div>
      <p className="sb-note">Telemetry tiles read from the SDK's InMemoryMetrics and count SDK-on sends only.</p>
    </>
  );
}

function EventLog({ log }: { log: LogLine[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      className="log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {log.map((l) => (
        <div key={l.id} className="log-line" data-kind={l.kind}>
          <span className="lt">{l.t}</span>
          <span className="lm">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}
