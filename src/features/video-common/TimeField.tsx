"use client";
import { useEffect, useRef, useState } from "react";
import { formatTime, parseTime } from "../../services/video/time";
export function TimeField({
  label,
  value,
  onCommit,
  onError,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  onError: () => void;
}) {
  const [text, setText] = useState(formatTime(value)),
    composing = useRef(false),
    focused = useRef(false);
  useEffect(() => {
    if (!composing.current && !focused.current) setText(formatTime(value));
  }, [value]);
  function commit(raw: string) {
    try {
      const parsed = parseTime(raw);
      onCommit(parsed);
      if (!focused.current) setText(formatTime(parsed));
    } catch {
      onError();
    }
  }
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={text}
        inputMode="decimal"
        maxLength={64}
        style={{ minHeight: 44, width: 190 }}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          setText(e.currentTarget.value);
          if (!focused.current) commit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          focused.current = false;
          if (!composing.current) commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.nativeEvent.isComposing &&
            !composing.current
          ) {
            e.preventDefault();
            commit(e.currentTarget.value);
          }
          if (e.key === "Escape") {
            setText(formatTime(value));
          }
        }}
      />
    </label>
  );
}
