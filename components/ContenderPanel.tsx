"use client";

import { Fragment, useEffect, useRef } from "react";
import type { PanelState } from "@/components/useArenaStream";

const PILL: Record<PanelState["state"], { cls: string; label: string }> = {
  queued: { cls: "queued", label: "QUEUED" },
  running: { cls: "run", label: "RUNNING" },
  pass: { cls: "pass", label: "PASS" },
  fail: { cls: "fail", label: "FAIL" },
  error: { cls: "error", label: "ERROR" },
};

const PY_KEYWORDS = /\b(def|return|while|if|not|None|or|and|is|new_head)\b/g;

// Minimal, safe Python highlight for the streamed code artifact — keywords get the
// accent-adjacent `kw` color, trailing `# comments` get the muted comment color.
function highlight(line: string): React.ReactNode {
  const hashAt = line.indexOf("#");
  const code = hashAt >= 0 ? line.slice(0, hashAt) : line;
  const comment = hashAt >= 0 ? line.slice(hashAt) : "";

  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PY_KEYWORDS.lastIndex = 0;
  while ((m = PY_KEYWORDS.exec(code)) !== null) {
    if (m.index > last) parts.push(code.slice(last, m.index));
    parts.push(
      <span className="kw" key={`${m.index}-${m[0]}`}>
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) parts.push(code.slice(last));
  if (comment) parts.push(
    <span className="cm" key="cm">
      {comment}
    </span>
  );

  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

function formatTime(panel: PanelState, now: number): string {
  if (panel.startedAt === null) return "0.0";
  const end = panel.finishedAt ?? now;
  return Math.max(0, (end - panel.startedAt) / 1000).toFixed(1);
}

export function ContenderPanel({
  panel,
  now,
  isWinner,
}: {
  panel: PanelState;
  now: number;
  isWinner: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const pill = PILL[panel.state];

  // keep the log pinned to the newest line as events stream in
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [panel.log]);

  return (
    <div className={`panel${isWinner ? " winner" : ""}`}>
      <div className="phead">
        <span className="nm">{panel.name}</span>
        <span className="mdl">{panel.model}</span>
        <span className={`pill ${pill.cls}`}>
          <span className="d" />
          {pill.label}
        </span>
      </div>

      <div className="log" ref={logRef}>
        {panel.log.map((item, i) =>
          item.kind === "line" ? (
            <div className={`l ${item.cls}`} key={i}>
              {item.text}
            </div>
          ) : (
            <div className="codeblock" key={i}>
              <div className="fname">{item.file}</div>
              <div className="cwrap">
                {item.lines.map((line, j) => (
                  <div className="cline" key={j}>
                    <span className="ln">{j + 1}</span>
                    <span className="ct">{highlight(line)}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
        {panel.state === "running" && <span className="cursor" />}
      </div>

      <div className="pfoot">
        <span>
          tok <b>{panel.tokens.toLocaleString()}</b>
        </span>
        <span>
          $<b>{panel.costUsd.toFixed(3)}</b>
        </span>
        <span>
          <b>{formatTime(panel, now)}</b>s
        </span>
      </div>
    </div>
  );
}
