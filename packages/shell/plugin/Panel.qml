import QtQuick
import QtQuick.Layouts
import QtQuick.Dialogs
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
  property var summary: ({ inFlight: 0, mined: 0, failed: 0, pendingRequests: 0, allowedOrigins: 0, deniedOrigins: 0 })

  function refresh() {
    if (!statusProc.running) statusProc.running = true;
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
    contentHeight: card.fittedContentHeight(col.implicitHeight)

  ColumnLayout {
    id: col
    anchors.fill: parent
    anchors.margins: 16
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

          Text {
            text: `${modelData.origin ?? "?"} · ${modelData.action ?? "spend"}${modelData.amount_sats ? ` · ${modelData.amount_sats} sats` : ""}`
            color: Color.foreground
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
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
              onClicked: root.runAppAction(["app", "open", modelData.domain])
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
