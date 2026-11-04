import type { TimelineEntry } from "@skail-document-signing/contracts";

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol aria-label="Timeline" className="timeline">
      {entries.map((e, i) => (
        <li key={i}>
          <time>{new Date(e.at).toLocaleTimeString("en-US")}</time> {e.text}
        </li>
      ))}
    </ol>
  );
}
