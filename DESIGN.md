---
name: Sentinel
description: A pass and its stub for a live plan run. A dark shell over a cool grey ground, a white pass that says where the run stands, and a stub coloured by what the run needs from you.
colors:
  ground: "#e6eaee"
  panel: "#ffffff"
  sunk: "#f1f3f5"
  hair: "#d6dce3"
  hair-2: "#bfc8d1"
  ink: "#10161d"
  ink-2: "#39434e"
  ink-3: "#5a6571"
  ink-4: "#8b95a0"
  steel-light: "#4f5b68"
  shell: "#10161d"
  shell-2: "#1b232c"
  shell-ink: "#f2f4f6"
  shell-ink-2: "#a8b1bb"
  shell-hair: "#2a333d"
  blue: "#1462c4"
  blue-fill: "#1a9fff"
  blue-soft: "#dcefff"
  amber: "#8a5800"
  amber-fill: "#f4b223"
  amber-soft: "#fdf2d6"
  red: "#c42b1f"
  red-soft: "#fbe8e6"
  green: "#0d7a4a"
  green-soft: "#e1f2e9"
  grey-fill: "#dde1e6"
  on-fill: "#10161d"
  on-strong: "#ffffff"
  ground-night: "#0b1016"
  panel-night: "#131b23"
  sunk-night: "#0f161d"
  hair-night: "#202a35"
  hair-2-night: "#2e3a47"
  ink-night: "#e9edf1"
  ink-2-night: "#bac3cc"
  ink-3-night: "#909ba7"
  ink-4-night: "#5d6873"
  shell-night: "#070a0d"
  shell-2-night: "#121820"
  shell-ink-2-night: "#909ba7"
  shell-hair-night: "#1d252d"
  blue-night: "#66c0f4"
  blue-soft-night: "#11293f"
  amber-night: "#f4b223"
  amber-soft-night: "#2f240b"
  red-night: "#ff7a6e"
  red-soft-night: "#3a1714"
  green-night: "#4fcb8d"
  green-soft-night: "#0e2a1d"
  grey-fill-night: "#27303a"
typography:
  word:
    fontFamily: "Libre Franklin, Segoe UI, sans-serif"
    fontSize: "54px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.005em"
  section:
    fontFamily: "Libre Franklin, Segoe UI, sans-serif"
    fontSize: "12.5px"
    fontWeight: 800
    lineHeight: "24px"
    letterSpacing: "0.07em"
  nav:
    fontFamily: "Libre Franklin, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.05em"
  stub-title:
    fontFamily: "Saira, Segoe UI, system-ui, sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.005em"
  say:
    fontFamily: "Saira, Segoe UI, system-ui, sans-serif"
    fontSize: "17.5px"
    fontWeight: 400
    lineHeight: 1.45
  panel-title:
    fontFamily: "Saira, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: "24px"
  body:
    fontFamily: "Saira, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: "Saira, Segoe UI, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 500
    lineHeight: 1
  figure:
    fontFamily: "Saira Semi Condensed, Saira, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: "26px"
  label:
    fontFamily: "Saira Semi Condensed, Saira, Segoe UI, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
    lineHeight: "18px"
    letterSpacing: "0.005em"
  button-primary:
    fontFamily: "Saira Semi Condensed, Saira, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.07em"
  tab:
    fontFamily: "Saira Semi Condensed, Saira, Segoe UI, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.07em"
  code:
    fontFamily: "IBM Plex Mono, ui-monospace, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  chip:
    fontFamily: "IBM Plex Mono, ui-monospace, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1
rounded:
  r1: "2px"
  r2: "4px"
  r3: "6px"
  r4: "10px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
  s12: "48px"
components:
  pass:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r4}"
    padding: "24px 32px 20px"
  stub-working:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.stub-title}"
    padding: "24px 28px 20px 30px"
  stub-needs-you:
    backgroundColor: "{colors.amber-fill}"
    textColor: "{colors.on-fill}"
    typography: "{typography.stub-title}"
    padding: "24px 28px 20px 30px"
  stub-stuck:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-strong}"
    typography: "{typography.stub-title}"
    padding: "24px 28px 20px 30px"
  stub-paused:
    backgroundColor: "{colors.grey-fill}"
    textColor: "{colors.ink}"
    typography: "{typography.stub-title}"
    padding: "24px 28px 20px 30px"
  stub-done:
    backgroundColor: "{colors.green}"
    textColor: "{colors.on-strong}"
    typography: "{typography.stub-title}"
    padding: "24px 28px 20px 30px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r3}"
  button:
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.r1}"
    height: "34px"
    padding: "0 15px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-strong}"
    typography: "{typography.button-primary}"
    rounded: "{rounded.r1}"
    height: "34px"
    padding: "0 15px"
  tab:
    textColor: "{colors.ink-2}"
    typography: "{typography.tab}"
    rounded: "{rounded.r1}"
    height: "32px"
    padding: "0 14px"
  field:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.r1}"
    height: "34px"
    padding: "7px 12px"
  trail-chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-2}"
    typography: "{typography.chip}"
    rounded: "{rounded.r1}"
    height: "28px"
    padding: "0 9px 0 8px"
  trail-chip-now:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue}"
    typography: "{typography.chip}"
    rounded: "{rounded.r1}"
    height: "28px"
    padding: "0 9px 0 8px"
  nav-tab:
    textColor: "{colors.shell-ink-2}"
    typography: "{typography.nav}"
    rounded: "{rounded.r3}"
    height: "40px"
    padding: "0 18px"
  nav-tab-current:
    backgroundColor: "{colors.on-strong}"
    textColor: "{colors.on-fill}"
    typography: "{typography.nav}"
    rounded: "{rounded.r3}"
    height: "40px"
    padding: "0 18px"
---

# Design System: Sentinel

Source of record: the browser dashboard `web/view.html` as shipped on 2026-10-30 (one HTML file with inline CSS and one inline script). The terminal pane (`hooks/views.tsx`) is a different surface drawn by the host and is out of scope. Every value above is read from that file's custom properties and rules.

## Overview

**Creative North Star: "The Pass and Its Stub"**

The run is a ticket. The pass, a white card at the top of the Run page, says where the run stands: a status word in heavy capitals, a plain sentence under it, the count of states done, a row of figures and the trail of states. Joined to its right edge by a dashed tear line is the stub. The stub carries what the run needs from you, coloured by that need, with the buttons to answer it. Two round cut-outs at the top and bottom of the tear line show the page through them.

Colour is meaning. Blue means Claude is here. Amber means you are needed. Red means stuck or failing. Green means passed. Grey means not yet, or paused. Controls carry no meaning, so they are ink and steel. The page is lit from the top in the run's colour, a soft glow that fades out before the plan, so the state reads before any word does. When the run is fine, the stub is a quiet grey and only small blue marks show where Claude is.

The frame around it is a dark shell: a 56px header bar with the logo, the plan's title and how fresh the data is, and a floating tab bar at the foot of the window for the two pages, Run and Library. Depth follows a game-store client's habit: fields and tracks sit into the surface, panels and chips stand on it, and the things you can open tip toward you when pointed at.

**Key Characteristics:**
- A dark shell, a cool grey ground and white panels; the dark theme swaps the ground and panels to blue-black and keeps the shell darker still.
- Four corner steps, chosen by what an element is, never by its size.
- Libre Franklin 800 capitals for the few words read from across the room; Saira for reading; Saira Semi Condensed for figures and labels; IBM Plex Mono for ids and code.
- A 14px square mark for every state: ticked ink when done, filled in the run's colour when current, dashed when ahead.
- Three depth levels: sit in, stand, tip. Buttons, tabs and tags stay flat.
- Native tooltips are replaced by one floating card, and a corner notice confirms what you did.

## Colors

A cool neutral sheet with five meanings, each used for one thing. Dark values live in the frontmatter under the `-night` suffix; the shell inks that do not change are not repeated.

### Primary
- **Claude Blue** (`blue`, `blue-fill`, `blue-soft`): where Claude is. The current state's mark and chip while working, the beat beside the freshness line, member agents in parallel runs, text selection. `blue` is for text, `blue-fill` for marks and bars, `blue-soft` for the chip behind a state's name.

### Secondary
- **Needs-You Amber** (`amber`, `amber-fill`, `amber-soft`): you are needed. The stub's fill for a question, a review or a draft, the badge on the Run tab, the tab icon's plate, and amber tags for a rule that waits on you. `amber` is the text shade in light theme; in the dark theme the fill colour is bright enough to be the text shade too.

### Tertiary
- **Stuck Red** (`red`, `red-soft`): stuck, failing, refused. The stuck stub, a failing check's output, the threshold mark on the health meter, refused calls in the time chart, error lines.
- **Passed Green** (`green`, `green-soft`): passed and done. The finished stub, a rule that is on, the ticks in a summary list.

### Neutral
- **Ground** (`ground`): the page behind everything, under the run's glow.
- **Panel and Sunk** (`panel`, `sunk`): panels stand in `panel`; wells, the working stub and alert boxes use `sunk`.
- **Ink 1 to 4** (`ink` to `ink-4`): text from strongest to quietest. `ink-3` is the lightest grey for reading text. `ink-4` is for marks, dashed outlines and disabled labels only.
- **Hair** (`hair`, `hair-2`): row dividers and chip edges; `hair-2` for the dashed edge of chips ahead and the tear line on a quiet stub.
- **Shell** (`shell` to `shell-hair`): the header, the tab bar and the notice. The same near-black in both themes, a step darker at night.
- **Steel** (`steel-light` to `ink`, as a left-to-right gradient): the face of the main button and of a button you point at. In the dark theme the gradient runs light, from `#f4f6f8` to `#aeb8c2`, with ink text.
- **Grey Fill** (`grey-fill`): the paused stub.
- **On Fill and On Strong** (`on-fill`, `on-strong`): text on amber or blue fills, and text on red or green fills. They do not change with the theme.

### Named Rules
**The Colour Is Meaning Rule.** A colour appears only to say what state something is in. Controls, frames and decoration get ink, steel or grey.

**The Words Beside Colour Rule.** Every colour that carries state has a word next to it: the status word in the pass, the stub's kicker, a tag. Red and green never stand alone.

**The Quiet Run Rule.** While the run works, the only colour is blue on the current state and the faint blue glow. Amber, red and green fills belong to the moments that need you or mark the finish.

## Typography

**Display Font:** Libre Franklin 800 (with Segoe UI, sans-serif)
**Body Font:** Saira (with Segoe UI, system-ui, sans-serif)
**Label Font:** Saira Semi Condensed (with Saira)
**Mono Font:** IBM Plex Mono (with ui-monospace, Consolas, monospace)

**Character:** Libre Franklin at its heaviest weight gives the status word and the count the weight of a printed ticket. Saira is a squared, slightly technical sans for reading; its condensed cut keeps figures, labels and the main button's capitals narrow. IBM Plex Mono sets state ids, commands and file paths. Figures are tabular everywhere they line up.

### Hierarchy
- **Word** (Libre Franklin 800, 54px, line height 1, capitals; 34px at 860px wide and under): the status word and the count in the pass. The slim bar repeats both at 16px.
- **Section** (Libre Franklin 800, 12.5px, 0.07em, capitals): section titles on the page, such as Plan and Where the time went, over a dashed rule that fades out to the right.
- **Nav** (Libre Franklin 800, 13px, 0.05em, capitals): the Run and Library tabs, and the product name in the header at 14px with 0.1em spacing.
- **Stub title** (Saira 700, 25px, line height 1.15): the question or task the stub asks about; 21px while the run is working.
- **Say** (Saira 400, 17.5px, line height 1.45, up to 64 characters wide): the sentence under the status word.
- **Panel title** (Saira 700, 17px): titles inside a panel, and 16px in the slip's header band.
- **Body** (Saira 400, 15px, line height 1.5): the page default.
- **Figure** (Saira Semi Condensed 600, 19px, tabular): the values in the pass's row of figures.
- **Label** (Saira Semi Condensed 500, 13.5px): field labels, the stub's kicker, freshness, meta lines.
- **Button primary and tab** (Saira Semi Condensed 700 at 13px and 600 at 12.5px, 0.07em, capitals): the main button and the view switches.
- **Code and chip** (IBM Plex Mono 400 at 13px, 500 at 12.5px in trail chips): ids, commands, files.

### Named Rules
**The Few Capitals Rule.** Libre Franklin is for the status word, the count, section titles, the tabs and the brand. Reading text is never set in it.

**The Sentence Case Rule.** Saira text is sentence case with no added letter spacing. Only the main button and the view switches use condensed capitals.

## Layout

One page per tab inside a 1440px wrapper with 24px gutters (16px at 860px and under), and 120px of room at the foot so the floating tab bar never covers the last row. The shell header runs edge to edge with its contents lined up with the wrapper.

The Run page stacks the pass, the slip (only while something needs you), then two columns: the plan views on the left and the side panel on the right. The pass is a grid of a flexible left part and a 368px stub. Once the pass scrolls out of view a slim bar slides down from the top with the status word, the sentence, the count and the stub's main button. At 1180px and under the side panel drops below the plan and the header loses the plan's meta line. At 860px and under the pass stacks with the stub under it (the tear line turns horizontal and the cut-outs go), the header keeps only the logo, freshness beat and buttons, and the slip's columns stack. At 480px the brand name drops, leaving the mark.

The trail is one row that scrolls sideways, held at the running state, with faded edges showing there is more. Opening a group makes it wider, never taller. The plan box is resizable in height and scrolls inside. The time chart draws at the box's width and never under 640px; narrower boxes scroll it sideways. Task pages open in place of the plan with a sticky bar on top (Back, "i of n", Previous and Next).

Spacing is a 4px grid: 4, 8, 12, 16, 20, 24, 32 and 48.

Scrolling with the wheel moves the page until a scroll box under the pointer is as far into view as it can get, then scrolls the box, then carries on with the page in the same movement.

## Elevation & Depth

Three levels, after a game-store client. Things sit in: fields, tracks, meters, the trail's open group frames, the List's flow box and unpicked choices, drawn with a dark edge, a shadow inside the top and a light line under the bottom edge. Things stand: panels, the pass and trail chips, drawn with a lit top edge and a 1px shadow, no border. Things tip: a chip, List row or Map card you point at keeps its top edge and tips its lower edge toward you, leaning toward the pointer, and its shadow falls deeper. Buttons, tabs and tags stay flat. The shell, the tab bar, the slim bar and the notice float above with a deep soft shadow.

### Shadow Vocabulary
- **Well** (`inset 0 1px 3px rgb(0 0 0 / .2), 0 1px 0 rgb(255 255 255 / .8)`): everything that sits in.
- **Panel** (`inset 0 1px 0 rgb(255 255 255 / .6), 0 1px 2px rgb(16 22 29 / .1)`): panels and the pass.
- **Lift** (`0 1px 2px rgb(16 22 29 / .18)`): trail chips at rest.
- **Slant** (`0 5px 7px -4px rgb(16 22 29 / .28), 0 1px 2px rgb(16 22 29 / .1)`): a pointed-at chip, row or card.
- **Float** (`0 1px 2px rgb(16 22 29 / .08), 0 8px 24px rgb(16 22 29 / .14)`): the slim bar; the tab bar and notice use a deeper version.

The dark theme uses the same shapes with black shadows at higher opacity and a fainter lit edge.

### Named Rules
**The Flat Controls Rule.** A button, tab or tag never lifts. Pointing at it changes its fill, never its height.

**The Tip Is For Opening Rule.** Only things that open something (a state chip, a List row, a Map card) tip toward the pointer. With reduced motion they stay still.

## Shapes

Four corner steps, set by what an element is:
- **r1, 2px:** anything you press or read as one item: buttons, fields, tabs, tags, chips, rows, Map cards, marks.
- **r2, 4px:** boxes nested in a panel: the List's flow box, the picker, group frames, callouts, code blocks, the hint card.
- **r3, 6px:** panels and notices.
- **r4, 10px:** the pass, the tab bar and dialogs.

Edges that dock to the window or to another surface lose their corners: the slim bar, the task page's top bar, and the stub's left side.

The pass is the one cut shape: a dashed tear line between the left part and the stub, with a 10px round cut-out at each end. The state mark is a 14px square. Done draws a tick in panel colour on ink; current fills with the run's colour and, while Claude works on it, a quarter arc turns inside; ahead is a dashed outline. Progress cells are 4 by 12px bars, one per state. Icons are drawn SVG strokes (1.8px, round caps).

## Components

### Pass and stub
The top of the Run page. The left part holds the status word in the run's text colour, the sentence, the count at the right, a row of figures (Now at, Elapsed, Tool calls, Health, Tokens, then Week and This plan when Claude Code reports them) over a hairline, and the trail. The stub takes the need's colour: sunk grey while working, amber for a question, review or draft, red when stuck, grey fill when paused, green when done. Its kicker names the need, its title says what, and its buttons sit at the bottom: a wash of the stub's ink, and the main button filled with it. A fine line under them says what else works ("Or reply in the chat") or what was sent and when. When the session is lost the buttons go and the fine line says how to reopen the dashboard.

### Slip
The detail behind the stub, shown under the pass only while something needs you: a panel outlined in the run's colour at 45%, with a header band that fades out from that colour. Its body is two columns: the question's options, Claude's proposal or outcome, the stuck run's failing output, or what locking a draft does, beside the answer box or the reasons. Options sit in until picked; Claude's recommended option carries a "Claude's pick" tag. Several questions get tabs, each ticked once answered.

### Logo
Four nodes, each joined to the centre by a curve and to the next node by an arc that stops short of it. One quarter (a node, its curve and its arc) is drawn and turned four times on a 260-unit square, nodes 100 units out, a 13-unit round stroke, nodes of radius 17. The arc's end is cut by a mask so it stops clear of the next node. In the header the mark is 22px beside SENTINEL in capitals. The tab icon is the same mark, ink on light tab bars and light on dark ones, on an amber plate while you are needed and a red plate while stuck.

### Shell and tabs
The header is a 56px shell bar: logo, a hairline, the plan's title and meta, then the freshness line with its beat, the notification bell and the theme button (32px, r1, outlined in `shell-hair`). The page tabs float at the foot of the window: a shell-coloured bar (r4, 4px padding) with two 40px tabs in Libre Franklin capitals. The page you are on is a raised white tile, the same in both themes. A badge on Run counts what needs you, in an amber tile with a soft glow.

### Project tabs
One page holds every session, with a thin bar across its top, 40px and a step lighter than the page's dark header. Each project is a browser tab: 34px tall, 148 to 232px wide, in Saira Semi Condensed, with 8px corners on top and none below. The one you are on has the header's colour, a faint light line along its top and a foot that curves out to the bar, so tab and header read as one shape. The others lie flat on the bar with a thin line between them and light up when pointed at. A tab's name is its folder's as words with capitals (docs-site reads Docs Site), and the hover keeps the folder's spelling. The close button is a drawn 14px cross in a 24px target, shown on the tab you are on and the one you point at. A tab's status is a word in a small tile: Needs you in amber, Stuck in red, Done in green, Paused outlined. A project that is running shows nothing, by the Quiet Run Rule. The bell sits at the right, and the pages inside hide their own. Under the bar, each session's page sits in a frame, unchanged. Many tabs scroll sideways, and the page never does.

### Buttons
- **Shape:** r1, 34px tall, 15px side padding; 28px for small buttons.
- **Default:** a 9% ink wash with ink text in Saira 500.
- **Primary:** the steel gradient with white text in condensed capitals; brighter when pointed at.
- **Hover:** default buttons turn to steel. Ghost buttons have no wash until pointed at.
- **Disabled:** a fainter wash with `ink-4` text.

### Tabs and switches
Joined tabs on a base line, 32px tall, in condensed capitals. The picked one is lit from the line up and the line under it turns to ink. Map, One line and List use this; so do the question tabs, and the Library's tabs, scope filters and "Switches for" choice.

### Tags and chips
- **Tag:** 22px, r1, a 9% ink wash. Green when a rule is on, amber when it waits on you, filled with the run's colour for the one that matters now (Now, You, Running).
- **Name chip:** a state id inside a sentence, in mono on the run's soft colour.
- **Trail chip:** 28px, r1, mono, standing on the page with a hair edge. Ahead chips are dashed and see-through; the current one takes the run's soft colour and edge.

### Inputs / Fields
- **Style:** sit in, with a dark edge, an inside shadow and a light line under the bottom; r1; 34px tall; textareas start at 76px and resize vertically.
- **Focus:** the edge sharpens to `ink-3` with a 1px ring.
- **Search:** a steel button joined to the field's right edge.
- **Choices:** tick boxes fill with ink and a drawn tick; switches are a square knob in a well.

### Cards / Containers
- **Panels:** r3, panel colour with a faint sheen from the top, the panel shadow, no border.
- **Section heads:** the title sits on the page above its frame, over a dashed rule that fades out before the controls on the right. The frame holds only content.
- **Callout:** an amber band that fades out to the right, with an icon.

### Plan views
- **Map:** cards wrap into rows inside group frames; lines run only in the gaps. Pointing at a card brings out its lines and the cards they reach. Folded groups show their cells. Ways back are lines under the boxes. Parallel plans draw as a graph of columns by depth.
- **One line:** the plan as a track that sits in and fills with ink up to where the run is, with stations as marks. Groups are tabs over their stretch of the line. A minimap strip under it frames what is in view.
- **List:** rows are bars 2px apart and 6px in from the frame; the running one is lit from the left in the run's colour. Columns are the mark, number, id, label, done-when and time. Flows are wells nested in the frame.

### System tab
A nav tab that shows once the project has a map, with or without a plan running. The head gives the map's name, the part count, how many are built and how many are left to test. Under it, two controls: the level (Overview, Areas, Parts, Tasks) and the view (All, Testing, Changes, with a count on Changes), and on wide screens the layout (Boxes or Outline). Narrow screens get Outline only.
- **Parts:** boxes in group frames, `.pt`. A part says its status in words beside the mark, never by colour alone: Not built, Already there, Will change, Claude is here, Untested, Tested, Changed since test, Check failing, Needs you. A group's frame takes one of seven tones from its parts: red, amber, blue, dashed (all Not built), plain (all Already there), green, or neutral for a mix. Outside parts are dotted when Guessed, and carry no Tested mark.
- **Lines:** solid, since they are Claude's drawing and the part's panel says so. Pointing at a part brings out its lines.
- **Tasks level:** each part shows a small tag for every task that builds it, with the full name in the hint. A "Tied to no part" strip above the map lists the tasks that build nothing, and is left out when there are none.
- **Banner:** when the update check finds parts that changed since the map was drawn, a row for each gives git's reason, with Redraw this area and It's fine. The list is cut at five rows and says how many it left out. With no git repo the banner says nothing could be compared, so a quiet map is never read as an unchanged one.
- **Side column:** the part's panel, the finish list, and the Testing or Changes view. Below them, "Not mapped yet" shows the folders no part reaches as plain boxes with their file counts, with "Not placed yet" for `.env.example` endpoint keys. Past plans come last, newest first, and pointing at one lights what it built.
- **Words from the map, git and plans are text:** they never run as markup.

### Side panel
Now (the current state's mark, id, title, a link to its task page, done-when, files, time on it, health and check runs), then Up next, Helper agents, Decided, Asked, Models and tokens, and the Log. While stuck, Now leads with the alert box: the check command and its failing output in red.

### Task page
Opens in place of the plan for one state. A sticky bar with Back and the pager, then a row of stat boxes (Status, Runs in, Used, Took, Started), a bar showing where the state sat in the run, and two columns: Asked for, why, approach, what was done, where it stands, what it needs, along the way and ways back on the left; done-when, files it may change and the flow that added it on the right. A live run offers Skip with a reason.
- **Asked for:** comes first because it is the only part in the user's or the plan's words; everything under it is Claude's description. Each quote sits in a sunk block with its section and origin below in small grey, and one line says Sentinel found the words, with a link to the saved copy. A state Claude added has a grey Claude added tag and its reason instead; the tag is amber only while the draft still waits for an answer. A plan that doesn't compare quotes keeps its `Plan:` line above the title instead.
- **Along the way:** a refused quote leads the list, with the same red Refused word as other refusals.

### Source page
Opens at `#source`, or at `#source-<state>` with that state's quotes picked out and brought into view. Run stays the current tab. A page head with Back, then the saved copy in a panel: a row of facts (source, where it came from, quoted by, sections no state quotes), then the text line by line, as written. Quotes are marked with a soft ink wash and no hue, and the picked state's quotes are darker with a hairline, so the Quiet Run Rule holds. The state chips sit in a column beside the text and under it below 860px; pressing one opens that state. A section nothing quotes has one small grey line under its heading. Below the copy, panels for the messages a quote uses and for what Claude added.

### Draft card: where the states came from
With a plan that compares quotes, the slip's left column leads with the count (a green tick, or an amber warning when nothing is quoted) and one amber line per source for the sections nothing quotes. Each state Claude added follows as a block with Keep it and Take it out, tinted amber until answered and sunk after. The quotes fold under a details row across both columns. While any addition is unanswered the stub says how many and Lock the plan stays disabled.

### Draft card: settings Claude chose
Only with Settings per state on, after the quotes. A grid of states, setting, reason and answers, one row for each reason (one column under 860px). The setting is a mini tag. A row that waits for an answer is tinted amber like an added state, and its tag gets the amber outline. The slip's stub counts them and holds Lock back.

### Library page
Two tabs, Instructions and Flows, and a "Switches for" choice between this project and your default. Claude's draft of either kind shows above them in a slip, outlined and banded in the run's colour.
- **Weights:** three cards in a row (one column under 860px), each with its name in Libre Franklin capitals, a line on what it is for, and a footer of figures: words per state, words once per plan, extra check runs. Slow extra time shows as amber cells. The picked card stands with an ink edge.
- **Experimental switch:** one sunk row under the weight note, with the switch, its title, an Experimental tag and a line saying it is for testing. It stays out of the instruction list and its totals. The System page's heading carries the same tag, with no switch.
- **Instruction rows:** bars 62px tall with a switch, the title and text, then the moment, a "Claude is told" or "Sentinel checks this" tag and the cost. A row that is off greys its words. A sunk strip under the list adds up what is on.
- **Detail panel:** the picked instruction's tags, its text, what it needs in a callout, and Copy to edit for a built-in, Trust for a file Sentinel didn't save, Edit and Delete for your own.
- **Flows:** a table with an On switch per row, a search box and a scope filter, and a detail panel (Edit, Duplicate, Delete).
- **Editors:** one per kind. The form is on the left; the flow editor has a sticky preview of the flow on the right, as the plan would show it.
- **On a draft:** the "Before you lock it" card adds "Deeper, not bigger" (the depth answers as tick rows, each with its question in small capitals) and "Instructions for this plan" (switches and a weight choice over the plan's own copy, with This plan only or Also make them this project's default).

### Hint card and notice
- **Hint card:** one floating card for every hint in place of the browser's tooltip, pale steel in both themes (r2, max 280px). A state's card names it, its title, its check and where it stands.
- **Notice:** pops up in the bottom right when something you did has taken (a flow saved or deleted): a shell-coloured card with a white tile and a passing shine, a tear line, and what happened. It goes by itself after 4.5 seconds.

### Time and agents
- **Where the time went:** the state rail beside the call chart on the call-step axis. Each call is a thin bar; a health line runs under the rows with the stuck threshold and the stuck stretch shaded.
- **Who's working:** in parallel runs, one lane per agent on the clock, bars where each worked, a line at now and what starts next.

## Do's and Don'ts

### Do:
- **Do** answer "does it need me" first, in the pass's status word and the stub, with a plain sentence under it.
- **Do** read every colour from the custom properties, and give each new colour a dark-theme value that still passes contrast on the dark panel.
- **Do** pick the corner step by what the element is: r1 for a single item, r2 for a nested box, r3 for a panel, r4 for the pass and dialogs.
- **Do** show state with the 14px square mark and a word.
- **Do** keep reading text at 12.5px or larger, with `ink-3` as the lightest reading grey.
- **Do** switch off tilt, eased scrolling and every animation under reduced motion.
- **Do** use the floating hint card in place of `title` tooltips; the script moves a `title` into it and keeps an icon button's name.

### Don't:
- **Don't** colour a control. Buttons, tabs and frames are ink and steel; colour is for state.
- **Don't** use amber, red or green fills for anything other than a need, a stuck run or the finish.
- **Don't** set reading text in Libre Franklin or in capitals.
- **Don't** lift buttons, tabs or tags; only openable things tip toward the pointer.
- **Don't** use `ink-4` for text that has to be read.
- **Don't** use emoji or character symbols as icons; draw them as SVG strokes.

## Not canonized

These are in the build but are not part of the system, so new surfaces should not copy them.
- Text at 11 to 11.5px: small tags, the Run badge and labels inside the SVG drawings. They sit below the 12.5px reading floor.
- The steel gradient is a button face, not a colour token; the frontmatter falls back to `ink` for the main button.
- The project tabs use the browser's own tooltips, as that bar has no hint card.
