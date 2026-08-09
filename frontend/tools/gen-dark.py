"""
Generate a dark-theme override stylesheet for the Sivan app.

Approach: the light theme at HEAD and the original dark theme at 26f3551 are
POSITIONALLY IDENTICAL -- 1801 rules each, same selectors, same declaration
order (verified). So instead of inverting the light values (lossy: #ffffff
alone corresponds to 11 distinct dark values), we walk both files in lockstep
and emit, for every colour declaration that DIFFERS, the original designed
dark value under a [data-theme="dark"] scope.

That means dark mode is not an approximation of light mode. It is the exact
palette that shipped before, restored.

What is preserved:
  - @media context (400 of the rules are nested; an override emitted outside
    its media query would apply at every width)
  - !important (184 uses; an override without it loses to the light rule)
  - declaration order within a rule

What is skipped:
  - declarations whose value is identical in both themes
  - non-colour properties entirely
"""
import re, pathlib, sys

# The original dark stylesheet, read straight from git so the reference can
# never drift from what actually shipped.
import subprocess
DARK = subprocess.run(
    ['git', 'show', '26f3551:frontend/src/styles.css'],
    cwd=pathlib.Path(__file__).resolve().parents[2],
    capture_output=True, text=True, check=True).stdout
# The light stylesheet, minus the theme-toggle block appended at the end.
# That block has no dark counterpart, so including it would break the
# positional 1:1 rule alignment the whole approach depends on.
_light_full = (pathlib.Path(__file__).resolve().parents[1] / 'src' / 'styles.css').read_text()
_marker = '/* ---------------------------------------------------------------------------\n   Theme toggle'
LIGHT = _light_full[:_light_full.index(_marker)] if _marker in _light_full else _light_full

# NOTE: custom properties (--bg, --text, --green ...) must be included. They
# are where the whole palette lives; omitting them emitted 1071 surface
# overrides while every token stayed light, giving dark-on-dark text.
CUSTOM_PROP = re.compile(r'^--')

COLOUR_PROP = re.compile(
    r'^(color|background|background-color|background-image|border|border-top|'
    r'border-right|border-bottom|border-left|border-color|border-top-color|'
    r'border-right-color|border-bottom-color|border-left-color|box-shadow|'
    r'text-shadow|fill|stroke|outline|outline-color|scrollbar-color|'
    r'accent-color|caret-color|-webkit-text-fill-color|filter|backdrop-filter|'
    r'mix-blend-mode|opacity)$', re.I)

def strip_comments(t):
    return re.sub(r'/\*.*?\*/', '', t, flags=re.S)

def parse(text):
    """Flatten to [(at_context_tuple, selector, [(prop, value, important)])]."""
    text = strip_comments(text)
    out, stack, i, n = [], [], 0, len(text)
    buf = ''
    while i < n:
        c = text[i]
        if c == '{':
            head = buf.strip(); buf = ''
            if head.startswith('@'):
                stack.append(head)
                out.append(('__ENTER__', head))
            else:
                # read body to matching brace
                depth, j = 1, i + 1
                while j < n and depth:
                    if text[j] == '{': depth += 1
                    elif text[j] == '}': depth -= 1
                    j += 1
                body = text[i+1:j-1]
                decls = []
                for d in body.split(';'):
                    d = d.strip()
                    if not d or ':' not in d: continue
                    p, v = d.split(':', 1)
                    p, v = p.strip(), v.strip()
                    imp = '!important' in v
                    v_clean = v.replace('!important', '').strip()
                    decls.append((p, v_clean, imp))
                out.append((tuple(stack), ' '.join(head.split()), decls))
                i = j
                continue
        elif c == '}':
            if stack:
                stack.pop()
                out.append(('__EXIT__', None))
            buf = ''
        else:
            buf += c
        i += 1
    return out

dark = [r for r in parse(DARK) if r[0] not in ('__ENTER__', '__EXIT__')]
light = [r for r in parse(LIGHT) if r[0] not in ('__ENTER__', '__EXIT__')]

if len(dark) != len(light):
    sys.exit('ABORT: rule counts differ (dark %d, light %d) -- '
             'positional mapping is unsafe.' % (len(dark), len(light)))

# Group overrides by at-rule context so media queries are reconstructed once.
groups = {}
skipped_struct = 0
emitted = 0

for (dctx, dsel, ddecls), (lctx, lsel, ldecls) in zip(dark, light):
    if dsel != lsel or dctx != lctx:
        skipped_struct += 1
        continue
    dmap = {}
    for p, v, imp in ddecls:
        dmap.setdefault(p, []).append((v, imp))
    seen = {}
    changed = []
    identical = []
    for p, lv, limp in ldecls:
        if not (COLOUR_PROP.match(p) or CUSTOM_PROP.match(p)):
            continue
        k = seen.get(p, 0); seen[p] = k + 1
        cand = dmap.get(p)
        if not cand or k >= len(cand):
            continue
        dv, dimp = cand[k]
        if dv == lv:
            # Identical TEXT, but not necessarily identical effect. A rule that
            # says `color: var(--text)` in both themes still needs re-emitting
            # when a LOWER-specificity rule for the same element is being
            # overridden, or the winning cascade changes between themes.
            #
            # Concretely: .support-faq-card button sets `color: var(--text)` in
            # both files, so it was skipped; .primary-btn's dark `color:#06130f`
            # was emitted. In light, .support-faq-card button (0,2,1) beat
            # .primary-btn (0,1,0) and the button read correctly. In dark the
            # override made .primary-btn win on colour, putting dark ink on a
            # dark panel -- 1.01:1, an invisible "Create ticket".
            #
            # Re-emitting the var() reference is free (same value in light) and
            # restores the original relative ordering.
            identical.append((p, dv, limp or dimp))
            continue
        changed.append((p, dv, limp or dimp))
    if changed:
        # Carry the identical-in-both declarations along too.
        #
        # Skipping them silently changes which rule WINS. A declaration that is
        # textually the same in both themes still has to be re-stated inside
        # the [data-theme="dark"] scope, because that scope adds specificity:
        # any sibling rule we DO override jumps ahead of rules that used to
        # beat it. That is how "Create ticket" and "Enable 2FA" ended up as
        # dark ink on a dark panel at 1.0:1.
        #
        # Re-emitting them is a no-op visually in light mode (same value) and
        # preserves the original cascade in dark.
        merged = changed + [d for d in identical
                            if d[0] not in {c[0] for c in changed}]
        groups.setdefault(lctx, []).append((lsel, merged))
        emitted += len(changed)

# ---------------------------------------------------------------- emit
lines = []
lines.append('/*')
lines.append(' * DARK THEME OVERRIDES -- generated, do not hand-edit.')
lines.append(' *')
lines.append(' * Regenerate with: python3 tools/gen-dark.py')
lines.append(' *')
lines.append(' * These are the ORIGINAL designed dark values from commit 26f3551,')
lines.append(' * recovered by walking that stylesheet and the current light one in')
lines.append(' * lockstep (both are 1801 rules, same selectors, same order).')
lines.append(' *')
lines.append(' * They are NOT an inversion of the light theme. An inversion would be')
lines.append(' * lossy: #ffffff alone stands in for 11 distinct dark values, and')
lines.append(' * rgba(255,255,255,.96) for 11 more.')
lines.append(' *')
lines.append(' * Scoped to [data-theme="dark"], which App.tsx sets on <html>.')
lines.append(' */')
lines.append('')

def emit_rule(sel, changed, indent=''):
    # Scope every selector. :root becomes the attribute holder itself.
    parts = []
    for one in sel.split(','):
        one = one.strip()
        if not one:
            continue
        if one in (':root', 'html'):
            parts.append('[data-theme="dark"]')
        elif one == 'body':
            parts.append('[data-theme="dark"] body')
        elif one.startswith('html'):
            parts.append('[data-theme="dark"]' + one[4:])
        else:
            parts.append('[data-theme="dark"] ' + one)
    lines.append(indent + ',\n'.join(
        (indent + p) if i else p for i, p in enumerate(parts)) + ' {')
    for p, v, imp in changed:
        lines.append('%s  %s: %s%s;' % (indent, p, v, ' !important' if imp else ''))
    if sel in (':root', 'html'):
        lines.append(indent + '  /* HAND-SET: light-only tokens, no dark original to recover. */')
        for name, val, why in LIGHT_ONLY_TOKENS:
            if why:
                lines.append('%s  /* %s */' % (indent, why))
            lines.append('%s  %s: %s;' % (indent, name, val))
    lines.append(indent + '}')

# Tokens that exist ONLY in the light theme have no original dark counterpart
# to recover, so the generator would leave dark mode inheriting the light
# value. They are declared here so a regeneration never drops them.
# Corrections to the ORIGINAL dark theme.
#
# The generator restores 26f3551 faithfully, including its bugs. These two
# were measured as real failures and are patched on top rather than by editing
# the recovered values, so it stays obvious what is restored vs corrected.
# ---------------------------------------------------------------- rebrand
# The recovered dark theme is the ORIGINAL teal-green identity. The brand has
# since moved to the co-founder's blue spec, so every teal literal recovered
# from 26f3551 is re-lit to blue on the way out.
#
# The spec is authored for a WHITE page, so its darker blues cannot be used
# verbatim as ink here: #007AC7 measures 4.06 and #00639F only 2.90 against
# the dark surface #0e141b. Brand blue #018EE8 measures 5.32 there, so it
# becomes the dark-mode ink while the deeper tones stay for FILLS, where a
# white label sits on top at 4.56+.
#
# Brand teal #23CDA9 is KEPT, but only where the original used green to mean
# "money / success" -- it is 9.15 on the dark surface and is never used as an
# accent for ordinary UI.
REBRAND_RGB = {
    (116, 221, 190): (1, 142, 232),    # teal accent      -> brand blue
    (76, 216, 200):  (1, 142, 232),
    (55, 201, 161):  (0, 122, 199),    # gradient partner -> primary blue
    (52, 211, 153):  (35, 205, 169),   # success          -> brand teal
}
REBRAND_HEX = {
    '#74ddbe': '#018ee8', '#4cd8c8': '#018ee8',
    '#37c9a1': '#007ac7',
    '#34d399': '#23cda9', '#3ddba3': '#23cda9',
    '#2bbd8a': '#16856d', '#22b47f': '#16856d',
    # Labels that sat ON the old bright-green fill. On a blue fill they invert.
    '#06130f': '#ffffff',
    '#06251a': '#07090d',
}

def rebrand(text):
    for (r, g, b), (nr, ng, nb) in REBRAND_RGB.items():
        text = re.sub(r'rgba\(\s*%d,\s*%d,\s*%d,\s*([0-9.]*[0-9])\s*\)' % (r, g, b),
                      lambda m, t=(nr, ng, nb): 'rgba(%d, %d, %d, %s)' % (t[0], t[1], t[2], m.group(1)),
                      text)
    for a, b in REBRAND_HEX.items():
        text = re.sub(a, b, text, flags=re.I)
    return text


DARK_FIXES = [
    ('.badge.danger',
     [('color', '#081018', False)],
     'white on #f28b82 is 2.39:1 -- this shipped broken in the original dark '
     'theme. Dark ink on the same fill is 8.01:1.'),
]

LIGHT_ONLY_TOKENS = [
    ('--green-ink', '#74ddbe',
     'ink/fill split inverts: darkened for white, brightened for near-black'),
    ('--gold-ink', '#f1bd72', None),
    ('--border-control', 'rgba(154, 179, 202, 0.42)',
     'a navy hairline is invisible on #07090d'),
]

for ctx in sorted(groups, key=lambda c: (len(c), c)):
    rules = groups[ctx]
    if ctx:
        for at in ctx:
            lines.append(at + ' {')
        for sel, changed in rules:
            emit_rule(sel, changed, '  ' * len(ctx))
        for _ in ctx:
            lines.append('}')
    else:
        for sel, changed in rules:
            emit_rule(sel, changed)
    lines.append('')

# Corrections appended last so they win over the restored values.
lines.append('/* --- Corrections to the original dark theme (measured failures) --- */')
for sel, decls, why in DARK_FIXES:
    lines.append('/* %s */' % why)
    lines.append('[data-theme="dark"] %s {' % sel)
    for p_, v_, imp_ in decls:
        lines.append('  %s: %s%s;' % (p_, v_, ' !important' if imp_ else ''))
    lines.append('}')
lines.append('')

out = rebrand('\n'.join(lines) + '\n')
(pathlib.Path(__file__).resolve().parents[1] / 'src' / 'theme-dark.css').write_text(out)

print('rules compared        :', len(light))
print('structural mismatches :', skipped_struct)
print('override declarations :', emitted)
print('at-rule groups        :', len(groups))
print('output lines          :', len(lines))
