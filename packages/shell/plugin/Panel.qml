import QtQuick
import QtQuick.Layouts
import QtQuick.Dialogs
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// BSV OS wallet panel: F8 spend dashboard (ledger + policy audit) with
// F9 agent cards, F1 store, and the F7 share target (anchor-a-file).
//
// Single view over `bsv history`: confirmed/in-flight transactions with
// per-status hints, open spend requests with Approve / Deny, and
// approvals/caps/denials with revoke. BarWidget.qml owns the bar pill
// and hands this panel the button to anchor against. All actions shell
// out to the `bsv` CLI, so daemon policy and the custody lock apply
// exactly as they do in a terminal.
Panel {
  id: root
  moduleName: "bsv.wallet"
  ipcTarget: "bsv.wallet"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  property bool hasWallet: false
  property bool locked: true
  property bool daemonUp: false
  property string address: ""
  property string balanceText: "—"
  property string identityKey: ""
  // P4/F3 system sign-in (see `bsv whoami`): the Twetch OIDC session,
  // null when signed out. Login shells the CLI, which opens the browser.
  property var identity: null
  property bool identityBusy: false
  // F16 Twetch companion: account key state (`bsv twetch status`), the
  // one-tap seed-derived import result, and its busy/notice lines.
  property var twetchAccount: null
  property bool twetchImportBusy: false
  property string twetchImportNote: ""
  // F3 identity shape (see `bsv cert list`): held certificates.
  // F8 history shape (see `bsv history`): transactions, open requests,
  // policies, and rollup counts — one poll instead of three.
  // F7 share state: last anchor result or error line.
  property var shareResult: null
  property string shareText: ""
  property bool shareOk: true
  property var certs: []
  property string certText: ""
  property bool certOk: true
  property var transactions: []
  property var requests: []
  property var policies: []
  property var agents: []
  // F1 store shape (see `bsv store`): catalog merged with installed
  // records and live permission data.
  property var store: []
  // F4 money view (see `bsv basket list` via `bsv history`): per-basket
  // balances with member counts.
  property var baskets: []
  // F5 collectibles (see `bsv ord list` / `bsv bsv21 list`): inscriptions
  // plus fungible positions. Read-only in the panel; sends stay in the CLI.
  property var ordinals: []
  property var ftokens: []
  // F6 inbox (see `bsv msg list`): stored envelopes with peer + time.
  // Plaintext only ever appears in msgText after an explicit Read.
  property var messages: []
  property string msgText: ""
  property bool msgOk: true
  // F10 recovery status (see `bsv recovery status`): set metadata only,
  // never shares. Ceremonies stay terminal-only by key-material policy.
  property var recoverySets: []
  property bool recoveryProtected: false
  // F12 board (see `bsv gig board`): live bounties + local lifecycle.
  // Claim/submit/paid stay CLI (keys, proofs, outpoints).
  property var gigBoard: []
  property var gigs: []
  property string gigText: ""
  property bool gigOk: true
  // F13 schedules (see `bsv nightshift list/runs`): standing orders with
  // per-cycle escrow states. Submit takes proof text; rest is one tap.
  property var shiftOrders: []
  property var shiftRuns: []
  // F11 explorer (see `bsv overlay health/topics/lookup`): overlay status
  // plus topic lookup. Tagging stays CLI (needs exact txids).
  property var overlays: []
  property string overlayText: ""
  property bool overlayOk: true
  property var summary: ({ inFlight: 0, mined: 0, failed: 0, pendingRequests: 0, allowedOrigins: 0, deniedOrigins: 0 })

  function refresh() {
    if (!statusProc.running) statusProc.running = true;
  }

  // Twetch avatars: OIDC `picture` is either a relative media filename
  // (media.ordinalswallet.com), a b:// reference, or an absolute URL.
  function identityAvatar() {
    const p = root.identity && root.identity.picture ? String(root.identity.picture) : "";
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p.replace(/^http:/i, "https:");
    if (p.startsWith("b://")) {
      const m = p.slice(4).match(/[a-f0-9]{64}/i);
      return m ? `https://api.twetch.com/v1/media/${m[0].toLowerCase()}.jpg?v=4` : "";
    }
    if (/^[a-f0-9]{64}$/i.test(p)) return `https://api.twetch.com/v1/media/${p.toLowerCase()}.jpg?v=4`;
    if (!p.includes("..")) return `https://media.ordinalswallet.com/${p}`;
    return "";
  }

  // NOTE: do NOT override open()/toggle()/close() here — the Panel base
  // routes toggle() through open(), so an override that calls back into
  // toggle() recurses forever. reveal() is our refresh-then-show entry.
  function reveal() {
    refresh();
    if (!root.opened) root.toggle();
  }

  Process {
    id: statusProc
    command: ["bsv", "status"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const s = JSON.parse(text);
          root.daemonUp = true;
          root.hasWallet = !!s.hasWallet;
          root.locked = !!s.locked;
          root.identityKey = s.identityKey ?? "";
          if (!balanceProc.running) balanceProc.running = true;
          if (!historyProc.running) historyProc.running = true;
          if (!storeProc.running) storeProc.running = true;
          if (!certsProc.running) certsProc.running = true;
          if (!whoamiProc.running) whoamiProc.running = true;
          if (!twetchStatusProc.running) twetchStatusProc.running = true;
          if (!ordProc.running) ordProc.running = true;
          if (!bsv21Proc.running) bsv21Proc.running = true;
          if (!msgSyncProc.running) msgSyncProc.running = true;
          if (!msgListProc.running) msgListProc.running = true;
          if (!recoveryProc.running) recoveryProc.running = true;
          if (!gigBoardProc.running) gigBoardProc.running = true;
          if (!gigListProc.running) gigListProc.running = true;
          if (!shiftOrdersProc.running) shiftOrdersProc.running = true;
          if (!shiftRunsProc.running) shiftRunsProc.running = true;
          if (!overlayHealthProc.running) overlayHealthProc.running = true;
        } catch (e) {
          root.daemonUp = false;
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.daemonUp = false; }
  }

  Process {
    id: balanceProc
    command: ["bsv", "balance"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const b = JSON.parse(text);
          root.address = b.address ?? "";
          const sats = (b.confirmed ?? 0) + (b.unconfirmed ?? 0);
          root.balanceText = `${(sats / 1e8).toFixed(8)} BSV`;
        } catch (e) {
          // daemon may be locked or walletless; panel shows state rows
        }
      }
    }
  }

  Process {
    id: historyProc
    command: ["bsv", "history"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const h = JSON.parse(text);
          root.transactions = h.transactions ?? [];
          root.requests = h.requests ?? [];
          root.policies = h.policies ?? [];
          root.agents = h.agents ?? [];
          root.baskets = h.baskets ?? [];
          if (h.summary) root.summary = h.summary;
        } catch (e) {
          root.transactions = [];
          root.requests = [];
          root.policies = [];
          root.agents = [];
          root.baskets = [];
        }
      }
    }
  }

  Process {
    id: storeProc
    command: ["bsv", "store"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.store = JSON.parse(text).store ?? [];
        } catch (e) {
          root.store = [];
        }
      }
    }
  }

  Process {
    id: certsProc
    command: ["bsv", "cert", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.certs = JSON.parse(text).certs ?? [];
        } catch (e) {
          root.certs = [];
        }
      }
    }
  }

  // P4/F3 system sign-in: `bsv login` performs the whole OIDC loopback
  // flow (opening the browser itself) and exits when the daemon session
  // lands. Busy state covers the browser round-trip; whoami re-polls after.
  Process {
    id: whoamiProc
    command: ["bsv", "whoami"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.identity = JSON.parse(text).session ?? null;
        } catch (e) {
          root.identity = null;
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.identity = null; }
  }

  Process {
    id: loginProc
    command: ["bsv", "login", "--force"]
    stdout: StdioCollector {
      onStreamFinished: {
        root.identityBusy = false;
        if (!whoamiProc.running) whoamiProc.running = true;
      }
    }
    onExited: (code) => {
      root.identityBusy = false;
      if (!whoamiProc.running) whoamiProc.running = true;
    }
  }

  Process {
    id: identityLogoutProc
    command: ["bsv", "logout"]
    stdout: StdioCollector {
      onStreamFinished: {
        if (!whoamiProc.running) whoamiProc.running = true;
      }
    }
  }

  // F16: Twetch account key. The one-tap import derives the key from the
  // enrolled seed inside the daemon (m/44'/0'/0'/0/0 by default) and
  // checks the derived public key against Twetch's key-linkage index, so
  // the panel can tell "verified as your account" from "not linked".
  Process {
    id: twetchStatusProc
    command: ["bsv", "twetch", "status"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const d = JSON.parse(text);
          root.twetchAccount = d.account ?? null;
        } catch (e) {
          root.twetchAccount = null;
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.twetchAccount = null; }
  }

  Process {
    id: twetchImportProc
    command: ["bsv", "twetch", "account", "import-seed"]
    stdout: StdioCollector {
      onStreamFinished: {
        root.twetchImportBusy = false;
        try {
          const d = JSON.parse(text);
          if (d && d.error) {
            root.twetchImportNote = `Import failed: ${d.error.message ?? d.error}`;
          } else {
            const r = d.result ?? d;
            const addr = r.address ? `${String(r.address).slice(0, 10)}…` : "?";
            if (r.matchesSession === true) {
              root.twetchImportNote = `Imported ${addr} — verified as your Twetch account`;
            } else if (r.verifiedUserId != null && r.matchesSession === false) {
              root.twetchImportNote = `Imported ${addr} — linked to user ${r.verifiedUserId}, not your signed-in account`;
            } else if (r.verifiedUserId == null) {
              root.twetchImportNote = `Imported ${addr} — not linked to a Twetch account yet`;
            } else {
              root.twetchImportNote = `Imported ${addr}`;
            }
          }
        } catch (e) {
          root.twetchImportNote = "Import finished — refresh to see status";
        }
        if (!twetchStatusProc.running) twetchStatusProc.running = true;
      }
    }
    onExited: (code) => {
      root.twetchImportBusy = false;
      if (code !== 0 && root.twetchImportNote === "") {
        root.twetchImportNote = `Import failed (exit ${code}) — is a wallet enrolled?`;
      }
    }
  }

  // F5 gallery polls (1Sat Stack; empty while locked — same as balance).
  Process {
    id: ordProc
    command: ["bsv", "ord", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.ordinals = JSON.parse(text).ordinals ?? [];
        } catch (e) {
          root.ordinals = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.ordinals = []; }
  }

  Process {
    id: bsv21Proc
    command: ["bsv", "bsv21", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.ftokens = JSON.parse(text).tokens ?? [];
        } catch (e) {
          root.ftokens = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.ftokens = []; }
  }

  // F6 inbox polls: sync pulls the relay, list renders stored envelopes
  // (ciphertext at rest — plaintext only in msgText after Read).
  Process {
    id: msgSyncProc
    command: ["bsv", "msg", "sync"]
    stdout: StdioCollector {
      onStreamFinished: {
        if (!msgListProc.running) msgListProc.running = true;
      }
    }
  }

  Process {
    id: msgListProc
    command: ["bsv", "msg", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.messages = JSON.parse(text).messages ?? [];
        } catch (e) {
          root.messages = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.messages = []; }
  }

  // F10 recovery status (metadata only — shares never touch the panel).
  Process {
    id: recoveryProc
    command: ["bsv", "recovery", "status"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.recoverySets = r.sets ?? [];
          root.recoveryProtected = !!r.protected;
        } catch (e) {
          root.recoverySets = [];
          root.recoveryProtected = false;
        }
      }
    }
    onExited: (code) => { if (code !== 0) { root.recoverySets = []; root.recoveryProtected = false; } }
  }

  // F12 board polls: live catalog (keyless) + local lifecycle rows.
  Process {
    id: gigBoardProc
    command: ["bsv", "gig", "board"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.gigBoard = JSON.parse(text).gigs ?? [];
        } catch (e) {
          root.gigBoard = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.gigBoard = []; }
  }

  Process {
    id: gigListProc
    command: ["bsv", "gig", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.gigs = JSON.parse(text).gigs ?? [];
        } catch (e) {
          root.gigs = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.gigs = []; }
  }

  // F13 schedules polls: orders + recent runs.
  Process {
    id: shiftOrdersProc
    command: ["bsv", "nightshift", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.shiftOrders = JSON.parse(text).orders ?? [];
        } catch (e) {
          root.shiftOrders = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.shiftOrders = []; }
  }

  Process {
    id: shiftRunsProc
    command: ["bsv", "nightshift", "runs"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.shiftRuns = JSON.parse(text).runs ?? [];
        } catch (e) {
          root.shiftRuns = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.shiftRuns = []; }
  }

  // F11 explorer: health snapshot + topic lookup runner.
  Process {
    id: overlayHealthProc
    command: ["bsv", "overlay", "health"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.overlays = JSON.parse(text).overlays ?? [];
        } catch (e) {
          root.overlays = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.overlays = []; }
  }

  Process {
    id: overlayLookupProc
    property string topic: ""
    property string address: ""
    command: address === "" ? ["bsv", "overlay", "lookup", topic] : ["bsv", "overlay", "lookup", topic, "--address", address]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          const n = (r.rows ?? []).length;
          root.overlayOk = true;
          root.overlayText = `${r.topic ?? "?"} · ${r.what ?? "?"}: ${n} row${n === 1 ? "" : "s"}`;
        } catch (e) {
          root.overlayOk = false;
          root.overlayText = "Lookup failed — topic looks like tm_<tokenId>, address required.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.overlayOk = false;
        root.overlayText = "Lookup failed — topic looks like tm_<tokenId>, address required.";
      }
    }
  }

  // Claim runner: `bsv gig claim <id>` (guided text when keyless).
  Process {
    id: gigClaimProc
    property string gigId: ""
    command: ["bsv", "gig", "claim", gigId]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.gigOk = true;
          root.gigText = r.guided ?? `Claimed ${r.id ?? ""} (${r.lifecycle ?? "?"})`;
          if (!gigListProc.running) gigListProc.running = true;
        } catch (e) {
          root.gigOk = false;
          root.gigText = "Claim failed — see terminal (`bsv gig claim`) for detail.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.gigOk = false;
        root.gigText = "Claim failed — see terminal (`bsv gig claim`) for detail.";
      }
    }
  }

  // Read runner: `bsv msg show <id>` decrypts for display (logged nowhere).
  Process {
    id: msgShowProc
    property string msgId: ""
    command: ["bsv", "msg", "show", msgId]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.msgOk = true;
          root.msgText = `${r.peer ? String(r.peer).slice(0, 12) + "…: " : ""}${r.text ?? ""}`;
          if (!msgListProc.running) msgListProc.running = true;
        } catch (e) {
          root.msgOk = false;
          root.msgText = "Read failed (locked?) — unlock, then Read again.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.msgOk = false;
        root.msgText = "Read failed (locked?) — unlock, then Read again.";
      }
    }
  }

  // Disclosure sheet runner: `bsv cert show <id> [--fields …]`; the result
  // text shows ONLY the disclosed fields, and the daemon logs the audit.
  Process {
    id: certProc
    property string certId: ""
    property string fields: ""
    command: fields === "" ? ["bsv", "cert", "show", certId] : ["bsv", "cert", "show", certId, "--fields", fields]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          const names = Object.keys(r.disclosed ?? {});
          root.certOk = true;
          root.certText = names.length > 0
            ? `Disclosed from ${r.cert?.type ?? "?"}: ${names.join(", ")} (logged)`
            : "Nothing disclosed.";
        } catch (e) {
          root.certOk = false;
          root.certText = "Disclosure failed — see terminal (`bsv cert show`) for detail.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.certOk = false;
        root.certText = "Disclosure failed — see terminal (`bsv cert show`) for detail.";
      }
    }
  }

  Process {
    id: actionProc
    property var args: []
    command: ["bsv"].concat(args)
    onExited: root.refresh()
  }

  // App windows outlive the click: `bsv app open` blocks until its window
  // closes, so Open must NOT reuse the single-shot actionProc above — a
  // second Open while one window lives would be swallowed by its running
  // guard (exactly the one-app-at-a-time symptom). A transient user scope
  // detaches the opener; the CLI keeps supervising its bridge/window pair
  // and the scope ends with it. The panel just stops waiting on clicks.
  Process {
    id: openProc
    property string domain: ""
    command: ["systemd-run", "--user", "--scope", "--quiet", "bsv", "app", "open", domain]
    onExited: root.refresh()
  }

  function openApp(domain) {
    openProc.domain = domain;
    openProc.running = true;
  }

  Process {
    id: shareProc
    property string path: ""
    command: ["bsv", "share", path]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.shareResult = r;
          root.shareOk = true;
          root.shareText = `Anchored ${r.filename ?? "file"} · ${String(r.txid ?? "?").slice(0, 12)}… · ${r.fee ?? "?"} sats`;
          if (!historyProc.running) historyProc.running = true;
        } catch (e) {
          root.shareResult = null;
          root.shareOk = false;
          root.shareText = "Share failed — see terminal (`bsv share`) for detail.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.shareResult = null;
        root.shareOk = false;
        root.shareText = "Not anchored (denied, locked, or empty wallet) — approve in Approvals above, unlock, then pick the file again.";
      }
    }
  }

  Process {
    id: openExplorerProc
    property string url: ""
    command: ["xdg-open", url]
  }

  function allow(origin) {
    if (actionProc.running) return;
    actionProc.args = ["allow", origin];
    actionProc.running = true;
  }

  function deny(origin) {
    if (actionProc.running) return;
    actionProc.args = ["deny", origin];
    actionProc.running = true;
  }

  function revokeAgent(name) {
    if (actionProc.running) return;
    actionProc.args = ["agent", "revoke", name];
    actionProc.running = true;
  }

  function runAppAction(args) {
    if (actionProc.running) return;
    actionProc.args = args;
    actionProc.running = true;
  }

  function gigTracked(id) {
    for (const g of (root.gigs ?? [])) if (g.id === id) return true;
    return false;
  }

  function gigLifecycle(id) {
    for (const g of (root.gigs ?? [])) if (g.id === id) return g.lifecycle ?? "?";
    return "?";
  }

  function storeLine(e) {
    const bits = [];
    if (e.blurb) bits.push(e.blurb);
    const caps = e.live ?? null;
    if (caps && (caps.spendCapSats ?? 0) > 0) bits.push(`asks ${caps.spendCapSats} sats`);
    else if (caps) bits.push("asks no spend");
    if (e.installed) bits.push(`installed · ${e.status ?? "?"}`);
    else bits.push(e.status === "not-installed" ? "not installed" : (e.status ?? "?"));
    for (const c of (e.changes ?? [])) bits.push(c);
    if (e.devOnly) bits.push("dev-only");
    return bits.join(" · ");
  }

  function lockNow() {
    if (actionProc.running) return;
    actionProc.args = ["lock"];
    actionProc.running = true;
  }

  // Live refresh: an open panel re-polls on open and every 10s, so
  // unlocks/approvals land without manual Refresh. Cheap local procs only.
  onOpenedChanged: {
    if (root.opened) root.refresh();
  }

  Timer {
    interval: 10000
    running: true
    repeat: true
    onTriggered: {
      if (root.opened) root.refresh();
    }
  }

  // The bar shows this panel as a layer-shell popout (KeyboardPanel, like
  // the clock calendar): anchored under the pill, dismissed on outside
  // click. A bare Panel never displays on its own, and xdg-popup cards
  // need a parent-surface handshake this host doesn't complete.
  KeyboardPanel {
    id: card
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    contentWidth: card.fittedContentWidth(Style.space(460))
    contentHeight: card.fittedContentHeight(col.implicitHeight, Style.space(560))

  // Long dashboard: the card caps at 560 and the column scrolls.
  ScrollView {
    id: scrollArea
    anchors.fill: parent
    clip: true
    ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
    ScrollBar.vertical.policy: ScrollBar.AsNeeded

  ColumnLayout {
    id: col
    width: scrollArea.availableWidth
    spacing: 10

    Text {
      text: "BSV Wallet"
      color: Color.foreground
      font.pixelSize: Style.font.title
      font.bold: true
    }

    Text {
      text: !root.daemonUp ? "Daemon unreachable — is bsv-walletd running?"
        : !root.hasWallet ? "No wallet yet — run `bsv create` in a terminal (back up the phrase)."
        : root.locked ? "Locked — run `bsv unlock` in a terminal to act."
        : `${root.balanceText} · ${root.address}`
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    Text {
      text: `${root.summary.mined} confirmed · ${root.summary.inFlight} in flight · ${root.summary.failed} failed · ${root.summary.allowedOrigins} approved · ${root.summary.deniedOrigins} revoked`
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    // P4/F3: system sign-in. One tap opens the hosted Twetch page; the
    // daemon stores the verified session and binds the unlocked wallet key.
    PanelSectionHeader { text: "Identity" }

    Text {
      visible: root.identity === null
      text: "Not signed in. First run needs a client created at id.entangleit.com/console — then `bsv login --client-id=…` in a terminal."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    Button {
      visible: root.identity === null
      text: root.identityBusy ? "Waiting for Twetch…" : "Sign in with Twetch"
      enabled: !root.identityBusy && root.daemonUp
      onClicked: {
        root.identityBusy = true;
        loginProc.running = true;
      }
    }

    RowLayout {
      visible: root.identity !== null
      spacing: 8
      Layout.fillWidth: true

      Image {
        visible: root.identityAvatar() !== ""
        source: root.identityAvatar()
        sourceSize.width: 36
        sourceSize.height: 36
        Layout.preferredWidth: 36
        Layout.preferredHeight: 36
      }

      ColumnLayout {
        spacing: 2
        Layout.fillWidth: true

        Text {
          text: `@${root.identity ? (root.identity.handle || root.identity.sub) : "?"}`
          color: Color.foreground
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
          Layout.fillWidth: true
        }

        Text {
          text: root.identity && root.identity.stale === true
            ? "session expired — sign in again"
            : root.identity && root.identity.walletIdentityKey
              ? `bound to ${String(root.identity.walletIdentityKey).slice(0, 10)}…`
              : "no wallet key bound yet — unlock the wallet and it fills in"
          color: Color.muted
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
          Layout.fillWidth: true
        }
      }

      Button {
        visible: root.identity !== null
        text: root.identityBusy ? "Signing in…" : "Sign in again"
        enabled: !root.identityBusy && root.daemonUp
        onClicked: {
          root.identityBusy = true;
          loginProc.running = true;
        }
      }

      Button {
        text: "Sign out"
        onClicked: identityLogoutProc.running = true
      }
    }

    // F16: one-tap Twetch account import. Derives the posting key from the
    // enrolled seed inside the daemon and verifies it against Twetch's
    // key index — the seed and the WIF never leave the machine.
    RowLayout {
      visible: root.daemonUp && root.hasWallet && !(root.twetchAccount && root.twetchAccount.imported === true)
      spacing: 8
      Layout.fillWidth: true

      Button {
        text: root.twetchImportBusy ? "Importing…" : "Import to Twetch"
        enabled: !root.twetchImportBusy && root.daemonUp
        onClicked: {
          root.twetchImportNote = "";
          root.twetchImportBusy = true;
          twetchImportProc.running = true;
        }
      }

      Text {
        text: "derive the posting key from your wallet seed (m/44'/0'/0'/0/0)"
        color: Color.muted
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
        Layout.fillWidth: true
      }
    }

    Text {
      visible: root.twetchAccount && root.twetchAccount.imported === true && root.twetchImportNote === ""
      text: root.twetchAccount && root.twetchAccount.address
        ? `Twetch posting key: ${String(root.twetchAccount.address).slice(0, 10)}…`
        : "Twetch posting key imported"
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    Text {
      visible: root.twetchImportNote !== ""
      text: root.twetchImportNote
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    PanelSectionHeader { text: `Approvals (${root.requests.length})` }

    ColumnLayout {
      spacing: 8
      visible: root.requests.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.requests
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          ColumnLayout {
            spacing: 2
            Layout.fillWidth: true

            Text {
              text: `${modelData.origin ?? "?"} · ${modelData.action ?? "spend"}${modelData.amount_sats ? ` · ${modelData.amount_sats} sats` : ""}`
              color: Color.foreground
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }

            Text {
              visible: !!modelData.jev
              text: modelData.jev
                ? `Jev: ${modelData.jev.verdict} p=${modelData.jev.prob.toFixed(2)} · risk ${modelData.jev.riskLevel} ${modelData.jev.risk.toFixed(2)} · conf ${modelData.jev.confidence.toFixed(2)}`
                : ""
              color: modelData.jev && modelData.jev.verdict === "deny" ? Color.urgent : Color.muted
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }
          }

          Button {
            text: "Approve"
            onClicked: root.allow(modelData.origin)
          }

          Button {
            text: "Deny"
            onClicked: root.deny(modelData.origin)
          }
        }
      }
    }

    Text {
      text: "No pending approvals."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.requests.length === 0
    }

    PanelSectionHeader { text: `Transactions (${root.transactions.length})` }

    ColumnLayout {
      spacing: 6
      visible: root.transactions.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.transactions
        ColumnLayout {
          spacing: 0
          Layout.fillWidth: true

          Text {
            text: `${String(modelData.txid ?? "?").slice(0, 12)}… · ${modelData.status ?? "?"}${modelData.label ? ` · ${modelData.label}` : ""}`
            color: Color.foreground
            font.pixelSize: Style.font.body
          }

          Text {
            text: modelData.hint ?? ""
            color: Color.muted
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
            Layout.fillWidth: true
            visible: (modelData.hint ?? "") !== ""
          }
        }
      }
    }

    Text {
      text: "No transactions yet — anchors and spends will land here."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.transactions.length === 0
    }

    PanelSectionHeader { text: `Policy (${root.policies.length})` }

    ColumnLayout {
      spacing: 8
      visible: root.policies.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.policies
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.origin ?? "?"} · ${modelData.mode ?? "?"}${(modelData.spend_cap_sats ?? 0) > 0 ? ` · cap ${modelData.spend_cap_sats} sats` : ""}`
            color: Color.foreground
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: modelData.mode === "deny" ? "Approve" : "Revoke"
            onClicked: modelData.mode === "deny" ? root.allow(modelData.origin) : root.deny(modelData.origin)
          }
        }
      }
    }

    PanelSectionHeader { text: `Agents (${root.agents.length})` }

    ColumnLayout {
      spacing: 6
      visible: root.agents.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.agents
        ColumnLayout {
          spacing: 0
          Layout.fillWidth: true

          RowLayout {
            spacing: 8
            Layout.fillWidth: true

            Text {
              text: `${modelData.name ?? "?"} · ${modelData.remaining ?? 0}/${modelData.budget_sats ?? 0} sats${(modelData.daily_sats ?? 0) > 0 ? ` · ${modelData.window_remaining ?? 0}/${modelData.daily_sats} today` : ""} · ${modelData.active ? "active" : (modelData.revoked ? "revoked" : "expired")}`
              color: modelData.active ? Color.foreground : Color.muted
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }

            Button {
              text: "Revoke"
              visible: modelData.active === true
              onClicked: root.revokeAgent(modelData.name)
            }
          }
        }
      }
    }

    Text {
      text: "No agent allowances — mint one with: bsv agent mint <name> --budget=<sats>."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.agents.length === 0
    }

    PanelSectionHeader { text: `Money (${root.baskets.length})` }

    ColumnLayout {
      spacing: 4
      visible: root.baskets.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.baskets
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: modelData.name ?? "?"
            color: Color.foreground
            font.pixelSize: Style.font.body
            font.bold: true
          }

          Text {
            text: `${((modelData.balance ?? 0) / 1e8).toFixed(8)} BSV · ${modelData.memberCount ?? 0} utxo`
            color: Color.muted
            font.pixelSize: Style.font.body
            Layout.fillWidth: true
          }
        }
      }
    }

    Text {
      text: "No baskets yet — create one with: bsv basket create <name>."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.baskets.length === 0
    }

    PanelSectionHeader { text: `Collectibles (${root.ordinals.length})` }

    ColumnLayout {
      spacing: 6
      visible: root.ordinals.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.ordinals
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.contentType ?? "?"} · ${modelData.contentLength ?? "?"} bytes · ${String(modelData.outpoint ?? "?").slice(0, 12)}…`
            color: Color.foreground
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "View"
            onClicked: {
              openExplorerProc.url = modelData.contentUrl;
              openExplorerProc.running = true;
            }
          }
        }
      }
    }

    Text {
      text: "No inscriptions held — sends stay in the CLI (`bsv ord send`)."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.ordinals.length === 0
    }

    PanelSectionHeader { text: `Tokens (${root.ftokens.length})` }

    ColumnLayout {
      spacing: 4
      visible: root.ftokens.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.ftokens
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: modelData.symbol ?? "?"
            color: Color.foreground
            font.pixelSize: Style.font.body
            font.bold: true
          }

          Text {
            text: `${modelData.balance ?? 0} · ${modelData.utxoCount ?? 0} utxo`
            color: Color.muted
            font.pixelSize: Style.font.body
            Layout.fillWidth: true
          }
        }
      }
    }

    Text {
      text: "No BSV21 positions."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.ftokens.length === 0
    }

    PanelSectionHeader { text: `Store (${root.store.length})` }

    ColumnLayout {
      spacing: 8
      visible: root.store.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.store
        ColumnLayout {
          spacing: 2
          Layout.fillWidth: true

          Text {
            text: `${modelData.name ?? modelData.domain ?? "?"} · ${modelData.domain ?? ""}`
            color: Color.foreground
            font.pixelSize: Style.font.body
            font.bold: true
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Text {
            text: root.storeLine(modelData)
            color: Color.muted
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          RowLayout {
            spacing: 8

            Button {
              text: "Install"
              visible: !modelData.installed && (modelData.status === "not-installed" || modelData.status === "invalid")
              onClicked: root.runAppAction(["app", "install", modelData.domain])
            }

            Button {
              text: "Open"
              visible: !!modelData.installed
              onClicked: root.openApp(modelData.domain)
            }

            Button {
              text: modelData.status === "widened" ? "Approve update" : "Update"
              visible: !!modelData.installed && (modelData.status === "available" || modelData.status === "widened" || modelData.status === "adopted")
              onClicked: modelData.status === "widened"
                ? root.runAppAction(["app", "update", modelData.domain, "--approve-widening"])
                : root.runAppAction(["app", "update", modelData.domain])
            }

            Button {
              text: "Remove"
              visible: !!modelData.installed
              onClicked: root.runAppAction(["app", "remove", modelData.domain])
            }
          }
        }
      }
    }

    Text {
      text: "No store entries — the catalog ships with the OS package."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.store.length === 0
    }

    PanelSectionHeader { text: "Share" }

    Text {
      text: "Anchor any file's fingerprint on-chain — same policy gate as the terminal."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    RowLayout {
      spacing: 8

      Button {
        text: "Anchor a file…"
        enabled: root.hasWallet && !root.locked
        // The native dialog lives outside the popout focus grab: close
        // the panel first so the grab doesn't eat the dialog.
        onClicked: { root.close(); fileDialog.open(); }
      }

      Button {
        text: "Open in explorer"
        visible: (root.shareResult?.explorer ?? "") !== ""
        onClicked: {
          openExplorerProc.url = root.shareResult.explorer;
          openExplorerProc.running = true;
        }
      }
    }

    Text {
      text: root.shareText
      color: root.shareOk ? Color.foreground : Color.urgent
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.shareText !== ""
    }

    FileDialog {
      id: fileDialog
      title: "Anchor a file on BSV"
      fileMode: FileDialog.OpenFile
      onAccepted: {
        // fileUrl looks like file:///home/… — strip the scheme for the CLI.
        const path = String(fileDialog.fileUrl).replace(/^file:\/\//, "");
        shareProc.path = decodeURIComponent(path);
        shareProc.running = true;
      }
    }

    PanelSectionHeader { text: `Identity (${root.certs.length})` }

    Text {
      text: root.identityKey !== "" ? `id: ${root.identityKey.slice(0, 12)}…${root.identityKey.slice(-6)}` : "identity locked — unlock to present certs"
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 8
      visible: root.certs.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.certs
        ColumnLayout {
          spacing: 2
          Layout.fillWidth: true

          Text {
            text: `${modelData.type ?? "?"} · ${String(modelData.certifier ?? "?").slice(0, 12)}… · ${modelData.valid ? (modelData.verified ? "verified" : "self-asserted") : (modelData.revoked ? "revoked" : "expired")}`
            color: modelData.valid ? Color.foreground : Color.muted
            font.pixelSize: Style.font.body
            font.bold: true
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Text {
            text: `fields: ${Object.keys(modelData.fields ?? {}).join(", ")}`
            color: Color.muted
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          RowLayout {
            spacing: 8

            TextField {
              id: fieldBox
              placeholderText: "fields a,b (blank = all)"
              Layout.fillWidth: true
            }

            Button {
              text: "Present"
              onClicked: {
                certProc.certId = modelData.id;
                certProc.fields = fieldBox.text.trim();
                certProc.running = true;
              }
            }

            Button {
              text: "Revoke"
              visible: !modelData.revoked
              onClicked: root.runAppAction(["cert", "revoke", modelData.id])
            }
          }
        }
      }
    }

    Text {
      text: root.certText
      color: root.certOk ? Color.foreground : Color.urgent
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.certText !== ""
    }

    Text {
      text: "No certificates — hold one with: bsv cert put --type=<t> --certifier=<key> --field <k>=<v>."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.certs.length === 0
    }

    PanelSectionHeader { text: `Inbox (${root.messages.length})` }

    Text {
      text: "ECDH direct messages. Ciphertext at rest — Read decrypts, Ack deletes at the relay."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 6
      visible: root.messages.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.messages
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.direction === "out" ? "→" : "←"} ${String(modelData.peer ?? "?").slice(0, 12)}…${modelData.acked ? "" : " · new"}`
            color: modelData.acked ? Color.muted : Color.foreground
            font.pixelSize: Style.font.body
            font.bold: !modelData.acked
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "Read"
            onClicked: {
              msgShowProc.msgId = modelData.id;
              msgShowProc.running = true;
            }
          }

          Button {
            text: "Ack"
            visible: !modelData.acked && modelData.direction !== "out"
            onClicked: root.runAppAction(["msg", "ack", modelData.id])
          }
        }
      }
    }

    Text {
      text: root.msgText
      color: root.msgOk ? Color.foreground : Color.urgent
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.msgText !== ""
    }

    Text {
      text: "No messages — send one with: bsv msg send <identityKey> --text <msg>."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.messages.length === 0
    }

    PanelSectionHeader { text: "Recovery" }

    Text {
      text: root.recoveryProtected
        ? "Guarded — see `bsv recovery status` for the set. Setup/rotate/restore are terminal ceremonies (shares never touch the UI)."
        : "Unprotected — one lost phrase loses everything. Run: bsv recovery setup --need <M> --guardian <name> …"
      color: root.recoveryProtected ? Color.foreground : Color.urgent
      font.pixelSize: Style.font.body
      font.bold: !root.recoveryProtected
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 4
      visible: root.recoverySets.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.recoverySets
        Text {
          text: `${String(modelData.setId ?? "?").slice(0, 8)}… · ${modelData.need ?? "?"}-of-${modelData.total ?? "?"} · ${(modelData.guardians ?? []).map((g) => g.name ?? "?").join(", ")}${modelData.superseded ? " · superseded" : ""}`
          color: Color.muted
          font.pixelSize: Style.font.body
          wrapMode: Text.Wrap
          Layout.fillWidth: true
        }
      }
    }

    PanelSectionHeader { text: `Gigs (${root.gigBoard.length})` }

    Text {
      text: "Paid micro-work. Track to watch, claim through agentpay, earnings land in the earnings basket."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 8
      visible: root.gigBoard.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.gigBoard
        ColumnLayout {
          spacing: 2
          Layout.fillWidth: true

          Text {
            text: `${modelData.title ?? "?"} · ${modelData.amountSats ?? 0} sats · ${modelData.status ?? "?"}`
            color: Color.foreground
            font.pixelSize: Style.font.body
            font.bold: true
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          RowLayout {
            spacing: 8

            Button {
              text: gigTracked(modelData.id) ? (gigLifecycle(modelData.id) === "tracked" ? "Tracked" : gigLifecycle(modelData.id)) : "Track"
              enabled: !gigTracked(modelData.id)
              onClicked: root.runAppAction(["gig", "track", modelData.id])
            }

            Button {
              text: "Claim"
              visible: gigTracked(modelData.id)
              onClicked: {
                gigClaimProc.gigId = modelData.id;
                gigClaimProc.running = true;
              }
            }

            Button {
              text: "Untrack"
              visible: gigTracked(modelData.id)
              onClicked: root.runAppAction(["gig", "untrack", modelData.id])
            }
          }
        }
      }
    }

    Text {
      text: root.gigText
      color: root.gigOk ? Color.foreground : Color.urgent
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.gigText !== ""
    }

    Text {
      text: "No open gigs on the board right now."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.gigBoard.length === 0
    }

    PanelSectionHeader { text: `NightShift (${root.shiftOrders.length})` }

    Text {
      text: "Standing orders: recurring agent work with per-cycle budgets. The daemon opens runs; agents claim, submit, you approve."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 8
      visible: root.shiftOrders.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.shiftOrders
        ColumnLayout {
          spacing: 2
          Layout.fillWidth: true

          RowLayout {
            spacing: 8
            Layout.fillWidth: true

            Text {
              text: `${modelData.name ?? "?"} · ${modelData.agent ?? "?"} · ${modelData.cycleSats ?? 0} sats/cycle · ${modelData.status ?? "?"}`
              color: modelData.status === "paused" ? Color.muted : Color.foreground
              font.pixelSize: Style.font.body
              font.bold: true
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }

            Button {
              text: modelData.status === "paused" ? "Resume" : "Pause"
              onClicked: modelData.status === "paused"
                ? root.runAppAction(["nightshift", "resume", modelData.id])
                : root.runAppAction(["nightshift", "pause", modelData.id])
            }
          }
        }
      }
    }

    ColumnLayout {
      spacing: 6
      visible: root.shiftRuns.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.shiftRuns
        ColumnLayout {
          spacing: 0
          Layout.fillWidth: true

          RowLayout {
            spacing: 8
            Layout.fillWidth: true

            Text {
              text: `#${modelData.id ?? "?"} ${modelData.agent ?? "?"} · ${modelData.cycleSats ?? 0} sats · ${modelData.status ?? "?"}`
              color: modelData.status === "approved" ? Color.muted : Color.foreground
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }

            Button {
              text: "Claim"
              visible: modelData.status === "due"
              onClicked: root.runAppAction(["nightshift", "claim", String(modelData.id)])
            }

            Button {
              text: "Approve"
              visible: modelData.status === "submitted"
              onClicked: root.runAppAction(["nightshift", "approve", String(modelData.id)])
            }

            Button {
              text: "Fail"
              visible: modelData.status === "due" || modelData.status === "claimed" || modelData.status === "submitted"
              onClicked: root.runAppAction(["nightshift", "fail", String(modelData.id)])
            }
          }

          RowLayout {
            spacing: 8
            visible: modelData.status === "claimed"
            Layout.fillWidth: true

            TextField {
              id: proofBox
              placeholderText: "proof text, then Submit"
              Layout.fillWidth: true
            }

            Button {
              text: "Submit"
              onClicked: root.runAppAction(["nightshift", "submit", String(modelData.id), "--proof", proofBox.text.trim()])
            }
          }
        }
      }
    }

    Text {
      text: "No standing orders — create one with: bsv nightshift create --name <n> --agent <a> --every <1h> --budget <sats>."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.shiftOrders.length === 0
    }

    PanelSectionHeader { text: `Overlays (${root.overlays.length})` }

    ColumnLayout {
      spacing: 4
      visible: root.overlays.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.overlays
        Text {
          text: `${modelData.name ?? "?"} · ${modelData.live ? `live ${modelData.latencyMs ?? "?"}ms` : "down"}`
          color: modelData.live ? Color.foreground : Color.muted
          font.pixelSize: Style.font.body
          wrapMode: Text.Wrap
          Layout.fillWidth: true
        }
      }
    }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: topicBox
        placeholderText: "tm_<tokenId>"
        Layout.fillWidth: true
      }

      TextField {
        id: topicAddrBox
        placeholderText: "address"
        Layout.fillWidth: true
      }

      Button {
        text: "Lookup"
        onClicked: {
          overlayLookupProc.topic = topicBox.text.trim();
          overlayLookupProc.address = topicAddrBox.text.trim();
          overlayLookupProc.running = true;
        }
      }
    }

    Text {
      text: root.overlayText
      color: root.overlayOk ? Color.foreground : Color.urgent
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.overlayText !== ""
    }

    Item { Layout.fillHeight: true }

    RowLayout {
      spacing: 8

      Button {
        text: "Refresh"
        onClicked: root.refresh()
      }

      Button {
        text: "Lock now"
        enabled: root.hasWallet && !root.locked
        onClicked: root.lockNow()
      }
    }
  }
  }
  }
}
