import { describe, expect, it } from "vite-plus/test";

import {
  type FocusedLoginField,
  guestFieldToWindowPoint,
  type LoginFieldCandidate,
  selectLoginField,
} from "./AutofillField.ts";

const field = (overrides: Partial<LoginFieldCandidate>): LoginFieldCandidate => ({
  type: "text",
  autocomplete: "",
  usable: true,
  focused: false,
  form: 0,
  ...overrides,
});

describe("selectLoginField", () => {
  it.each<{
    readonly name: string;
    readonly fields: ReadonlyArray<LoginFieldCandidate>;
    readonly expected: number | null;
  }>([
    { name: "empty page", fields: [], expected: null },
    {
      name: "focused field wins over the login form",
      fields: [field({ type: "email" }), field({ type: "password" }), field({ focused: true })],
      expected: 2,
    },
    {
      name: "focused but unusable field is ignored",
      fields: [field({ type: "email" }), field({ type: "password", focused: true, usable: false })],
      expected: 0,
    },
    {
      name: "username autocomplete before the password",
      fields: [
        field({ type: "search", form: -1 }),
        field({ autocomplete: "section-login username" }),
        field({ autocomplete: "one-time-code" }),
        field({ type: "password" }),
      ],
      expected: 1,
    },
    {
      name: "nearest text field in the password's form when nothing looks like a username",
      fields: [
        field({ form: 0 }),
        field({ form: 1 }),
        field({ type: "checkbox", form: 1 }),
        field({ type: "password", form: 1 }),
      ],
      expected: 1,
    },
    {
      name: "username-like field in another form is skipped",
      fields: [field({ type: "email", form: 0 }), field({ type: "password", form: 1 })],
      expected: 1,
    },
    {
      name: "hidden fields are skipped",
      fields: [
        field({ type: "email", usable: false }),
        field({ type: "password", usable: false }),
        field({ type: "password" }),
      ],
      expected: 2,
    },
    {
      name: "username-first page without a password",
      fields: [field({ type: "search" }), field({ autocomplete: "email webauthn" })],
      expected: 1,
    },
    {
      name: "plain text fields alone are not a login",
      fields: [field({}), field({ type: "tel" })],
      expected: null,
    },
  ])("$name", ({ fields, expected }) => {
    expect(selectLoginField(fields)).toBe(expected);
  });
});

describe("guestFieldToWindowPoint", () => {
  const focused = (overrides: Partial<FocusedLoginField>): FocusedLoginField => ({
    x: 10,
    y: 20,
    width: 200,
    height: 30,
    viewportWidth: 800,
    canCopy: false,
    hasValue: false,
    ...overrides,
  });
  const webviewRect = { x: 300, y: 100, width: 800, height: 600 };

  it.each<{
    readonly name: string;
    readonly input: Parameters<typeof guestFieldToWindowPoint>[0];
    readonly expected: { readonly x: number; readonly y: number } | null;
  }>([
    {
      name: "anchors below the field at unit scale",
      input: { webviewRect, hostZoomFactor: 1, field: focused({}) },
      expected: { x: 310, y: 150 },
    },
    {
      name: "host zoom scales into window points",
      input: { webviewRect, hostZoomFactor: 1.25, field: focused({}) },
      expected: { x: 387, y: 187 },
    },
    {
      name: "guest zoom or a scaled viewport shrinks guest pixels",
      input: { webviewRect, hostZoomFactor: 1, field: focused({ viewportWidth: 1600 }) },
      expected: { x: 305, y: 125 },
    },
    {
      name: "a field scrolled past the viewport clamps to the webview",
      input: { webviewRect, hostZoomFactor: 1, field: focused({ x: -50, y: 900 }) },
      expected: { x: 300, y: 700 },
    },
    {
      name: "an unlaid-out guest has no anchor",
      input: { webviewRect, hostZoomFactor: 1, field: focused({ viewportWidth: 0 }) },
      expected: null,
    },
    {
      name: "a collapsed webview has no anchor",
      input: { webviewRect: { ...webviewRect, width: 0 }, hostZoomFactor: 1, field: focused({}) },
      expected: null,
    },
  ])("$name", ({ input, expected }) => {
    expect(guestFieldToWindowPoint(input)).toEqual(expected);
  });
});
