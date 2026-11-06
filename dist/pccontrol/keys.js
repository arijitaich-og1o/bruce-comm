import { BruceError } from '../util.js';
/** Canonical modifier order (used in parse results). */
export const MODIFIERS = ['cmd', 'shift', 'option', 'control', 'fn'];
const MODIFIER_ALIASES = {
    cmd: 'cmd',
    command: 'cmd',
    super: 'cmd',
    meta: 'cmd',
    win: 'cmd',
    ctrl: 'control',
    control: 'control',
    alt: 'option',
    option: 'option',
    opt: 'option',
    shift: 'shift',
    fn: 'fn',
    // xdotool / X11 keysym names of the left and right modifier keys
    super_l: 'cmd',
    super_r: 'cmd',
    meta_l: 'cmd',
    meta_r: 'cmd',
    control_l: 'control',
    control_r: 'control',
    alt_l: 'option',
    alt_r: 'option',
    shift_l: 'shift',
    shift_r: 'shift',
};
/**
 * macOS ANSI virtual key codes by lower-case name (incl. xdotool and DOM style aliases). Like the Mac key label,
 * "delete" is the backward delete key (= backspace); forward delete is "forwarddelete" / "del".
 */
export const KEY_CODES = buildKeyCodes();
function buildKeyCodes() {
    const letters = {
        a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
        o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
    };
    const digits = { '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29 };
    const fkeys = {
        f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
        f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
    };
    const named = {
        return: 36, enter: 36, tab: 48, space: 49, spacebar: 49,
        backspace: 51, delete: 51, forwarddelete: 117, del: 117,
        escape: 53, esc: 53,
        up: 126, down: 125, left: 123, right: 124,
        arrowup: 126, arrowdown: 125, arrowleft: 123, arrowright: 124,
        home: 115, end: 119,
        pageup: 116, page_up: 116, prior: 116,
        pagedown: 121, page_down: 121, next: 121,
        minus: 27, '-': 27,
        // "plus" is the =/+ key (cmd+plus = cmd+= zooms in); "+" itself separates the parts of a combo.
        equal: 24, equals: 24, '=': 24, plus: 24,
        leftbracket: 33, bracketleft: 33, '[': 33,
        rightbracket: 30, bracketright: 30, ']': 30,
        backslash: 42, '\\': 42,
        semicolon: 41, ';': 41,
        quote: 39, apostrophe: 39, "'": 39,
        comma: 43, ',': 43,
        period: 47, '.': 47,
        slash: 44, '/': 44,
        grave: 50, '`': 50,
        // xdotool names (lower-cased: matching is case-insensitive); keypad keys
        kp_enter: 76,
        kp_0: 82, kp_1: 83, kp_2: 84, kp_3: 85, kp_4: 86, kp_5: 87, kp_6: 88, kp_7: 89, kp_8: 91, kp_9: 92,
        kp_decimal: 65, kp_multiply: 67, kp_add: 69, kp_subtract: 78, kp_divide: 75, kp_equal: 81,
    };
    return { ...letters, ...digits, ...fkeys, ...named };
}
const EXAMPLES = '"cmd+s", "Return", "cmd+shift+t", "cmd+a", "escape", "f5", "page_down", "cmd+[", "option+left"';
/** Normalise one modifier name (alias, any case); throws invalid_argument for anything else. */
export function parseModifier(raw) {
    const mod = MODIFIER_ALIASES[String(raw).trim().toLowerCase()];
    if (!mod) {
        throw new BruceError('invalid_argument', `Unknown modifier "${raw}".`, 'Modifiers: cmd (command/super/meta/win), shift, option (alt/opt), control (ctrl), fn.');
    }
    return mod;
}
/** Normalise a modifier list: aliases resolved, duplicates dropped, canonical order. */
export function normalizeModifiers(list) {
    const set = new Set(list.map(parseModifier));
    return MODIFIERS.filter((m) => set.has(m));
}
/**
 * Parse a key combo such as "cmd+shift+t", "Return" or "ctrl+[". Parts are separated by "+", matching is
 * case-insensitive; exactly one non-modifier key is required.
 */
export function parseKeyCombo(combo) {
    const text = typeof combo === 'string' ? combo.trim() : '';
    if (!text)
        throw new BruceError('invalid_argument', 'No key given.', `Examples: ${EXAMPLES}.`);
    const parts = text.split('+').map((p) => p.trim().toLowerCase());
    const modifiers = new Set();
    let key;
    for (const part of parts) {
        if (!part)
            throw new BruceError('invalid_argument', `Malformed key combo "${combo}" (empty part).`, `Examples: ${EXAMPLES}.`);
        const mod = MODIFIER_ALIASES[part];
        const code = KEY_CODES[part];
        if (mod !== undefined) {
            modifiers.add(mod);
            continue;
        }
        if (code === undefined) {
            throw new BruceError('invalid_argument', `Unknown key "${part}" in "${combo}".`, `Examples: ${EXAMPLES}. Letters a-z, digits 0-9, f1-f20 and named keys work.`);
        }
        if (key !== undefined) {
            throw new BruceError('invalid_argument', `"${combo}" names more than one key.`, `Use exactly one key plus modifiers, e.g. ${EXAMPLES}. Send keys one after another with separate pc_key calls.`);
        }
        key = code;
    }
    if (key === undefined) {
        throw new BruceError('invalid_argument', `"${combo}" has only modifiers and no key.`, `Add one key, e.g. ${EXAMPLES}.`);
    }
    return { key_code: key, modifiers: MODIFIERS.filter((m) => modifiers.has(m)) };
}
//# sourceMappingURL=keys.js.map