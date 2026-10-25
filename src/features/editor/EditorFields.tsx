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
      <input
        key={value}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={Number(value.toFixed(3))}
        onBlur={(e) => {
          const value = Number(e.target.value);
          if (Number.isFinite(value) && value >= min && value <= max)
            onChange(value);
          else e.target.value = String(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing)
            e.currentTarget.blur();
        }}
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
  const props = {
    "aria-label": label,
    key: value,
    defaultValue: value,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.target.value !== value) onChange(e.target.value);
    },
  };
  return (
    <label>
      {label}
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} />}
    </label>
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
