import type { UiState } from "@skail-document-signing/contracts";

interface Props {
  title: string;
  ui: UiState;
  busy: boolean;
  onTitle: (title: string) => void;
  onSend: () => void;
}

export function ContractForm({ title, ui, busy, onTitle, onSend }: Props) {
  return (
    <section className="controls">
      <label htmlFor="title">Contract</label>
      <input
        id="title"
        value={title}
        disabled={!ui.enabled || busy}
        maxLength={120}
        onChange={(e) => onTitle(e.target.value)}
      />
      <button id="start" type="button" disabled={!ui.enabled || busy} onClick={onSend}>
        {ui.label}
      </button>
    </section>
  );
}
