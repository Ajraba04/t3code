import * as Schema from "effect/Schema";

export const LoginFieldCandidate = Schema.Struct({
  type: Schema.String,
  autocomplete: Schema.String,
  usable: Schema.Boolean,
  focused: Schema.Boolean,
  form: Schema.Int,
});
export type LoginFieldCandidate = typeof LoginFieldCandidate.Type;

export const FocusedLoginField = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  viewportWidth: Schema.Number,
  canCopy: Schema.Boolean,
  hasValue: Schema.Boolean,
});
export type FocusedLoginField = typeof FocusedLoginField.Type;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const TEXT_TYPES = new Set(["text", "email", "tel"]);
const CANDIDATE_STASH = "__t3AutofillCandidates";
const MAX_CANDIDATES = 200;

const isUsernameLike = (candidate: LoginFieldCandidate): boolean =>
  candidate.type === "email" ||
  candidate.autocomplete.split(/\s+/u).some((token) => token === "username" || token === "email");

const isFillable = (candidate: LoginFieldCandidate): boolean =>
  candidate.usable && (candidate.type === "password" || TEXT_TYPES.has(candidate.type));

/** Picks the field AutoFill should anchor to: the focused one, else the login's username, else its password. */
export function selectLoginField(candidates: ReadonlyArray<LoginFieldCandidate>): number | null {
  const focused = candidates.findIndex((candidate) => candidate.focused && isFillable(candidate));
  if (focused !== -1) return focused;

  const password = candidates.findIndex(
    (candidate) => candidate.usable && candidate.type === "password",
  );
  if (password === -1) {
    const username = candidates.findIndex(
      (candidate) => isFillable(candidate) && isUsernameLike(candidate),
    );
    return username === -1 ? null : username;
  }

  const form = candidates[password]!.form;
  let fallback: number | null = null;
  for (let index = password - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (!candidate.usable || candidate.form !== form || !TEXT_TYPES.has(candidate.type)) continue;
    if (isUsernameLike(candidate)) return index;
    fallback ??= index;
  }
  return fallback ?? password;
}

/** Maps a guest field's bottom-left corner to window coordinates for `menu.popup`. */
export function guestFieldToWindowPoint(input: {
  readonly webviewRect: Rect;
  readonly hostZoomFactor: number;
  readonly field: FocusedLoginField;
}): { readonly x: number; readonly y: number } | null {
  const { webviewRect, hostZoomFactor, field } = input;
  if (!(field.viewportWidth > 0) || !(webviewRect.width > 0) || !(hostZoomFactor > 0)) {
    return null;
  }
  // The ratio covers guest zoom and the scaled responsive viewport alike.
  const scale = webviewRect.width / field.viewportWidth;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const x = webviewRect.x + clamp(field.x * scale, webviewRect.width);
  const y = webviewRect.y + clamp((field.y + field.height) * scale, webviewRect.height);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.floor(x * hostZoomFactor), y: Math.floor(y * hostZoomFactor) };
}

// Runs in an isolated world: page scripts cannot read the stash or spoof the result.
export const COLLECT_LOGIN_FIELDS_SCRIPT = `(() => {
  const inputs = Array.from(document.querySelectorAll("input")).slice(0, ${MAX_CANDIDATES});
  globalThis.${CANDIDATE_STASH} = inputs;
  const forms = Array.from(document.forms);
  return inputs.map((input) => {
    const rect = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return {
      type: input.type,
      autocomplete: (input.getAttribute("autocomplete") || "").toLowerCase(),
      usable: !input.disabled && !input.readOnly && rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" && style.display !== "none",
      focused: input === document.activeElement,
      form: input.form ? forms.indexOf(input.form) : -1,
    };
  });
})()`;

export const focusLoginFieldScript = (index: number): string => `(() => {
  const input = globalThis.${CANDIDATE_STASH}?.[${Math.trunc(index)}];
  if (!(input instanceof HTMLInputElement) || !input.isConnected) return null;
  input.focus();
  const rect = input.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: window.innerWidth,
    canCopy: input.type !== "password" && input.selectionStart !== input.selectionEnd,
    hasValue: input.value.length > 0,
  };
})()`;
