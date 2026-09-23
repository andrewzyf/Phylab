import { useEffect, useRef, useState } from "react";
import { PRESETS, type InterpretResult, type Issue } from "@physicslab/shared";
import { useStore, type ChatEntry } from "../store";
import { Icon } from "./Icon";

const EXAMPLES = [
  "A ball of mass 2kg rolling down a frictionless ramp at 30 degrees",
  "A 500g ball is thrown horizontally at 10 m/s from a 20 meter cliff",
  "A pendulum with 1 meter length, released from 45 degrees",
  "Drop a bowling ball and a feather from 10 m on the moon",
  "A 1 kg ball at 4 m/s hits a stationary 3 kg ball, perfectly elastic, in space",
];

export function IssuesList({ issues, compact = false }: { issues: Issue[]; compact?: boolean }) {
  const update = useStore((s) => s.updateScenario);
  const shown = issues.filter((i) => i.severity !== "info" || !compact);
  if (!shown.length) return null;
  return (
    <ul className="issues">
      {shown.map((i, k) => (
        <li key={k} className={`issue issue-${i.severity}`}>
          <Icon name={i.severity === "error" ? "error" : i.severity === "warning" ? "warning" : "info"} size={16} />
          <div>
            <div>{i.message}</div>
            {i.suggestion ? <div className="muted small">{i.suggestion}</div> : null}
            {i.fix ? (
              <button type="button" className="chip" onClick={() => update(i.fix!.changes, "A")}>
                {i.fix.label}
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="interp-section" open={open}>
      <summary>
        <Icon name="chevron" size={14} />
        {title}
      </summary>
      <div className="interp-body">{children}</div>
    </details>
  );
}

function InterpretationCard({ result, latest }: { result: InterpretResult; latest: boolean }) {
  const send = useStore((s) => s.send);
  const run = useStore((s) => s.run);
  const applyVariation = useStore((s) => s.applyVariation);
  const busy = useStore((s) => s.busy);
  const variantA = useStore((s) => s.variants.A);
  const it = result.interpretation;
  const issues = latest && variantA ? variantA.validation.issues : (result.issues ?? []);
  const canRun = latest && variantA ? variantA.validation.canRun : !(result.issues ?? []).some((i) => i.severity === "error");
  return (
    <div className="interp-card">
      <div className="interp-source">
        {result.source === "ai" ? (
          <span className="badge badge-ai">
            <Icon name="sparkle" size={12} /> {result.model ?? "Claude"}
          </span>
        ) : result.source === "library" ? (
          <span className="badge">Scenario details</span>
        ) : (
          <span className="badge">Offline interpreter</span>
        )}
        {result.status === "needs_clarification" ? <span className="badge badge-warn">Needs clarification</span> : null}
      </div>
      {result.fallback_reason ? <p className="muted small">{result.fallback_reason}</p> : null}
      {it.summary ? <p className="interp-summary">{it.summary}</p> : null}
      {it.objects.length ? (
        <Section title={`Objects (${it.objects.length})`}>
          <ul className="kv-list">
            {it.objects.map((o, i) => (
              <li key={i}>
                <strong>{o.name}</strong> <span className="muted">{o.details}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {it.forces.length ? (
        <Section title="Forces">
          <ul className="kv-list">
            {it.forces.map((f, i) => (
              <li key={i}>
                <strong>{f.name}</strong> <span className="muted">{f.details}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {it.calculations.length ? (
        <Section title="Physics calculations">
          <ul className="calc-list">
            {it.calculations.map((c, i) => (
              <li key={i}>
                <div className="calc-label">{c.label}</div>
                <div className="calc-expr">{c.expression}</div>
                <div className="calc-result">{c.result}</div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {it.assumptions.length ? (
        <Section title="Assumptions I made" open={false}>
          <ul className="check-list">
            {it.assumptions.map((a, i) => (
              <li key={i}>
                <Icon name="check" size={14} /> {a}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {it.expected_outcome ? (
        <Section title="Expected outcome">
          <p>{it.expected_outcome}</p>
        </Section>
      ) : null}
      {it.physics_notes ? (
        <Section title="Why it happens" open={false}>
          <p>{it.physics_notes}</p>
        </Section>
      ) : null}
      {issues.length ? <IssuesList issues={issues} compact /> : null}
      {it.questions.length && latest ? (
        <div className="questions">
          {it.questions.map((q, i) => (
            <div key={i} className="question">
              <div className="question-text">❓ {q.question}</div>
              <div className="chips">
                {q.options.map((o) => (
                  <button key={o} type="button" className="chip" disabled={busy} onClick={() => send(o)}>
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {latest && result.scenario ? (
        <div className="interp-actions">
          <button type="button" className="button button-primary" disabled={!canRun} onClick={run}>
            <Icon name="play" size={14} /> Run simulation
          </button>
          {result.suggested_variations.length ? <span className="muted small">or try a variation:</span> : null}
          <div className="chips">
            {result.suggested_variations.map((v) => (
              <button key={v.label} type="button" className="chip chip-accent" title={v.description} onClick={() => applyVariation(v)}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Message({ entry, latest }: { entry: ChatEntry; latest: boolean }) {
  if (entry.role === "user")
    return (
      <div className="msg msg-user" data-msg={entry.id}>
        {entry.text}
      </div>
    );
  if (entry.pending)
    return (
      <div className="msg msg-assistant">
        <ThinkingIndicator />
      </div>
    );
  if (entry.error)
    return (
      <div className="msg msg-assistant msg-error">
        <Icon name="error" size={16} /> {entry.error}
      </div>
    );
  return (
    <div className="msg msg-assistant" data-msg={entry.id}>
      {entry.text ? <p>{entry.text}</p> : null}
      {entry.result ? <InterpretationCard result={entry.result} latest={latest} /> : null}
    </div>
  );
}

function ThinkingIndicator() {
  const [secs, setSecs] = useState(0);
  const ai = useStore((s) => s.health?.ai.enabled);
  useEffect(() => {
    const t = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const stage = secs < 4 ? "Reading your description…" : secs < 12 ? "Working out the forces and initial conditions…" : secs < 30 ? "Checking the physics and writing the explanation…" : "Still thinking — detailed scenarios can take a minute…";
  return (
    <div className="thinking" role="status">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {ai ? stage : "Interpreting…"} <span className="muted small">{secs > 2 ? `${secs}s` : ""}</span>
    </div>
  );
}

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.busy);
  const health = useStore((s) => s.health);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const lastWithResult = [...chat].reverse().find((c) => c.result)?.id;

  const last = chat[chat.length - 1];
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (last?.role === "assistant" && !last.pending && last.result) {
      // Show the start of the new interpretation rather than its end.
      const node = el.querySelector<HTMLElement>(`[data-msg="${last.id}"]`);
      if (node) el.scrollTop = node.offsetTop - 8;
    } else el.scrollTop = el.scrollHeight;
  }, [chat.length, last?.pending]);

  const submit = () => {
    if (!text.trim()) return;
    void send(text);
    setText("");
  };

  return (
    <section className="chat" aria-label="Describe a scenario">
      <div className="chat-list" ref={listRef}>
        {chat.map((c) => (
          <Message key={c.id} entry={c} latest={c.id === lastWithResult} />
        ))}
        {chat.length === 1 ? (
          <div className="examples">
            <div className="muted small">Try one of these:</div>
            {EXAMPLES.map((e) => (
              <button key={e} type="button" className="example" onClick={() => send(e)}>
                {e}
              </button>
            ))}
            <div className="muted small">…or open the library for {PRESETS.length} classic experiments.</div>
          </div>
        ) : null}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={chat.length > 2 ? "Ask for a change, e.g. “make the ramp steeper”…" : "Describe a physics scenario…"}
          rows={2}
          maxLength={4000}
          aria-label="Scenario description"
        />
        <button type="submit" className="button button-primary icon-button" disabled={busy || !text.trim()} aria-label="Send">
          <Icon name="send" size={16} />
        </button>
      </form>
      <div className="composer-foot muted small">
        {health === undefined ? "Connecting…" : health?.ai.enabled ? `Interpreted by ${health.ai.model}` : "Offline interpreter (add an Anthropic API key on the server for AI interpretation)"}
      </div>
    </section>
  );
}
