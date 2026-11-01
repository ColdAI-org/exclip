# Branding

ExClip runs under any name. You set your name, logo, colours and legal
links in `exclip.config.ts`, rebuild, and the app and the wallet window use
them. You change no code, so you keep taking updates with `git pull`.

Rebrand freely; keep the "Powered by ExClip" credit. "ExClip" and its logo
are trademarks of ColdAI LLC, and the Apache-2.0 licence covers the code,
not the name or the logo (section 6; see [NOTICE](../NOTICE)). So a copy
you run for other people needs your own name and logo: it mustn't present
itself as ExClip or use the ExClip logo. The only use of the ExClip name it
needs is [the credit](#the-credit), which ColdAI LLC permits. The
[brand kit](../brand/README.md) is for ExClip itself.

[Configuration](configuration.md#brand) lists each setting and its default.
This page shows where each one appears and what to check.

## Rebrand in five steps

1. **Start a config**, if you haven't:

   ```sh
   cp exclip.config.example.ts exclip.config.ts
   ```

   The copy is git-ignored, so a pull never touches it. To keep several
   configs, give each one a folder and keep the file name, for example
   `deploy/acme/exclip.config.ts`: Git ignores that name in any folder.
   Then set `EXCLIP_CONFIG=deploy/acme/exclip.config.ts` for the build and
   for the server.
2. **Add your logo** to `apps/web/public`, under a name of your own, for
   example `apps/web/public/acme.svg`. Git leaves an untracked file alone
   when you pull. An `https://` URL works too, with the limits under
   [the logo](#the-logo).
3. **Set the brand:**

   ```ts
   brand: {
     name: "Acme Swap",
     operator: "Acme Ltd",
     logo: "/acme.svg",
     colors: {
       accent: "#00B4F0",
       accentHover: "#38C8FF",
       accentInk: "#0077B6",
     },
     termsUrl: "https://acme.example/terms",
     privacyUrl: "https://acme.example/privacy",
   },
   ```

4. **Pick your colours** and check them against
   [the contrast rule](#the-contrast-rule).
5. **Rebuild and restart.** Run `pnpm build` and restart the server. In
   development, restart `pnpm dev`: the dev servers read the config only
   when they start.

The config checks each value when the server starts and when the apps are
built. A name with `<` or `>`, a logo path with `..`, a colour that isn't
`#RRGGBB` or a legal link that isn't `https://` stops the build, with a list
of every problem.

## Where your brand shows

### The name

- **Tab titles.** Every screen's title has it, for example "Portfolio ·
  Acme Swap". The home page's is "Acme Swap: trade crypto across every
  chain".
- **The side rail**, next to the logo, on screens 1024 px wide and up.
  Narrower screens show the logo alone.
- **The app's texts**, such as "Acme Swap never holds your funds" and the
  home page's "New on Acme Swap".
- **The trade review's fee row:** "Acme Swap fee: None", or the rate and
  the amount when you charge a fee ([fees](fees.md)).
- **The activity export**, named `acme-swap-activity-<date>.csv`: the name
  in lower case, with each run of other characters turned into a dash. A
  name with no letters or digits from `a` to `z` and `0` to `9` gives
  `exclip-activity-<date>.csv`.
- **The web app manifest**, as `name` and `short_name`.
- **The wallet window:** its tab title and heading, "Acme Swap wallet", and
  its texts, such as "Create your Acme Swap wallet".
- **Passkeys.** A password manager lists each passkey as "Acme Swap wallet",
  under the wallet's host.

An empty name means "ExClip".

### The operator

- **The footer** says "Acme Swap is run by Acme Ltd.", then that the app is
  non-custodial and that swaps settle through SODAX. With no operator, it
  has only the second sentence.
- **The wallet window** names the operator where it matters who does what:
  who keeps the encrypted backup ("Acme Ltd stores an encrypted backup it
  cannot read"), who will never ask for the recovery phrase, and whose fee
  a swap carries, on its review. The app's passkey sheet repeats the backup
  sentence. With no operator, these use the name.

Set the operator to the company or person that runs the site. People should
know who they trade with
([operator responsibility](../README.md#operator-responsibility)).

### The logo

- **In the app:** the side rail at 32 px, the phone's top bar at 28 px, and
  the home page's welcome at 48 px, before a wallet connects. Each is a
  square box, so a square logo works best: a wide one is shrunk or
  stretched to fit. The logo is decorative: the link around it carries the
  name for screen readers.
- **The app's tab icon.**
- **The web app manifest.** Your logo is its only icon. ExClip's PNG
  home-screen icons and its Apple touch icon are listed only with ExClip's
  own name and logo, so they never appear under another brand.
- **The wallet window's tab icon.** The wallet's CSP loads images only from
  its own origin and from `data:` URLs, so the build inlines the logo into
  the wallet page as a `data:` URL. That works for a `.svg`, `.png`, `.ico`
  or `.webp` file in `apps/web/public`. If the file is one of those and is
  missing, the wallet build stops. An `https://` logo, or another file
  type, leaves the window with the browser's default icon.

The logo sits on the near-black canvas in the dark theme, the default, and
on the near-white canvas in the light theme. A mark on a tile of its own,
as ExClip's is, reads on both.

### The colours

The app sets the three colours on its root element as `--brand-accent`,
`--brand-accent-hover` and `--brand-accent-ink`.
[`exclip.css`](../apps/web/src/styles/exclip.css) uses them like this:

| Colour | Dark theme (the default) | Light theme |
|---|---|---|
| `accent` | Primary buttons, the action circles and badges, all with dark text or icons (`#03141C`) on them; input focus borders; the tint behind the selected menu item and banners | The same, except the input focus borders and the tint |
| `accentHover` | Buttons and action circles on hover; links and the selected menu icon; the focus ring | Buttons and action circles on hover |
| `accentInk` | Not used | Links and the selected menu icon; the focus ring and input focus borders; the tint behind the selected menu item and banners |

The accent never means up or down. Price moves are green and red, and
always come with an arrow or a sign.

### Your legal pages

`brand.termsUrl` and `brand.privacyUrl` add "Terms of use" and "Privacy"
links to the footer, which open in a new tab. With neither, the footer has
no legal links.

## The credit

The footer of the app and of the wallet window ends with "Powered by
ExClip", a link to [ExClip's repository](https://github.com/ColdAI-org/exclip)
that opens in a new tab. Under ExClip's own name, it reads "ExClip is open
source" instead. [NOTICE](../NOTICE) makes it ExClip's attribution notice,
and no setting removes it.

The credit is 12 px text, underlined, in the footer's own text colour
rather than your accent, so it stays readable whatever colours you pick:
at least 6:1 against the background in both themes, in the app and in the
wallet window.

## The contrast rule

The config checks that each colour is written as `#RRGGBB`. It doesn't
check that text stays readable: that part is yours. ExClip's colours carry
small text, so hold every pairing to at least 4.5:1, the WCAG 2.2 level for
normal text:

| Colour | Must reach 4.5:1 against | ExClip's default reaches |
|---|---|---|
| `accent` | The dark canvas `#07080A`, and the button label `#03141C` | `#00B4F0`: 8.38:1 and 7.84:1 |
| `accentHover` | The dark canvas `#07080A`, and the button label `#03141C` | `#38C8FF`: 10.37:1 and 9.70:1 |
| `accentInk` | White `#FFFFFF`, and the light canvas `#F6F7F9` | `#0077B6`: 4.87:1 and 4.54:1 |

The defaults' ratios are the ones `pnpm run brand` prints
([brand kit: colour](../brand/README.md#colour)). Any WCAG contrast checker
works for yours, for example
[WebAIM's](https://webaim.org/resources/contrastchecker/).

In practice, `accent` and `accentHover` must be light and saturated, and
`accentInk` a darker shade of the same hue. Leave some room above 4.5:1.
Links and focus rings also sit on the app's cards and sheets, which are a
shade lighter than the canvas in the dark theme and a shade darker than
white in the light theme.

Focus rings and input focus borders need at least 3:1 against what's
around them (WCAG 2.2 SC 1.4.11). An accent light enough for the dark
theme falls short of that on white, as ExClip's `#00B4F0` does at 2.39:1,
so the light theme draws them in `accentInk`, which the 4.5:1 rule above
already covers.

## What doesn't change

- **The credit**, "Powered by ExClip", at the end of the footer of the app
  and of the wallet window ([the credit](#the-credit)).
- **The wallet window's colours.** It has a fixed palette of its own, blue
  on white or on near-black, following the system's light or dark setting.
  Its build takes the brand name and the operator, not the colours.
- **The canvas and surfaces.** Only the accent colours are yours. The
  canvas, the text colours and the browser's theme colour stay as they are.
- **Names nobody sees:** the API path `/api/exclip`, the config file's name,
  the browser storage keys (such as `exclip.activity.v1`) and the package
  names. They show only in the browser's developer tools.
- **ExClip's files in the build.** The build copies all of
  `apps/web/public`, so ExClip's `/logo.svg` and `/icons/exclip-*.png` are
  still served, though no page or manifest points to them. If you'd rather
  not serve them, delete them from `apps/web/dist` after the build.

ExClip has no setting for PNG home-screen icons of your own. Your logo is
the manifest's only icon.

## Check your rebrand

1. Restart `pnpm dev`, or build and serve.
2. The tab title, the side rail and the footer show your name, logo and
   operator, and the footer ends with "Powered by ExClip". Switch the theme
   and look again.
3. Open a trade and get a quote. The review's fee row carries your name.
4. Tab through a screen. The focus ring is visible on every button and
   link, in both themes.
5. Open the passkey wallet. Its title, heading and tab icon are yours, and
   its footer ends with "Powered by ExClip".
6. After a build, `apps/web/dist/manifest.webmanifest` has your name and
   your logo.

## Changing the brand later

- **Rebuild both apps** and redeploy. The name, the logo and the colours
  are baked into each build.
- **Passkeys keep working.** Each one keeps the name it was made with, so
  older passkeys still show the old name in password managers. A passkey
  belongs to the wallet's host, not to its name.
- **Keep the wallet's host.** A new brand doesn't need one, and moving it
  locks people out of their wallet in your app
  ([the passkey wallet](wallet.md#for-operators)).
- **A new app domain is fine.** Set `origins.app` and rebuild both apps.
  What each browser keeps (trade history, the theme) stays with the old
  domain.
