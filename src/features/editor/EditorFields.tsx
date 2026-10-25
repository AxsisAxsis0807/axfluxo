import { useContext, useEffect, useId, useRef, useState } from "react";
import { EditorDraftContext } from "./EditorDraftContext";
export function NumberField({
  label,
  value,
  onChange,
  min = -16384,
  max = 16384,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <DraftInput
        label={label}
        value={String(Number(value.toFixed(3)))}
        numeric
        min={min}
        max={max}
        step={step}
        onCommit={(text) => onChange(Number(text))}
      />
    </label>
  );
}
export function TextField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label>
      {label}
      <DraftInput
        label={label}
        value={value}
        multiline={multiline}
        onCommit={onChange}
      />
    </label>
  );
}

function DraftInput({
  label,
  value,
  onCommit,
  numeric,
  min,
  max,
  step,
  multiline,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  numeric?: boolean;
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}) {
  const notify = useContext(EditorDraftContext),
    id = useId();
  const [draft, setDraft] = useState(value),
    composing = useRef(false);
  useEffect(() => {
    if (!composing.current) setDraft(value);
  }, [value]);
  useEffect(() => () => notify?.(id, false), [id, notify]);
  const accept = (text: string) =>
    !numeric ||
    (text.trim() !== "" &&
      Number.isFinite(Number(text)) &&
      Number(text) >= (min ?? -Infinity) &&
      Number(text) <= (max ?? Infinity));
  const update = (text: string, commit: boolean) => {
    setDraft(text);
    const valid = accept(text) && !composing.current;
    notify?.(id, !valid);
    if (valid && commit && text !== value) onCommit(text);
  };
  const props = {
    "aria-label": label,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      update(e.target.value, !!notify),
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      update(e.target.value, true),
    onCompositionStart: () => {
      composing.current = true;
      notify?.(id, true);
    },
    onCompositionEnd: (
      e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      composing.current = false;
      update(e.currentTarget.value, !!notify);
    },
    onKeyDown: (
      e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      if (numeric && e.key === "Enter" && !e.nativeEvent.isComposing)
        e.currentTarget.blur();
    },
  };
  return multiline ? (
    <textarea {...props} rows={4} maxLength={20000} />
  ) : (
    <input
      {...props}
      type={numeric ? "number" : "text"}
      min={min}
      max={max}
      step={step}
      maxLength={numeric ? undefined : 20000}
    />
  );
}

export const colorField = (
  label: string,
  value: string,
  onChange: (v: string) => void,
) => (
  <label className="color-field">
    {label}
    <span>
      <input
        aria-label={label}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <code>{value.toUpperCase()}</code>
    </span>
  </label>
);
