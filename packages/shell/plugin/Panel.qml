import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// BSV OS wallet panel: F8 spend dashboard (ledger + policy audit).
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
  // F8 history shape (see `bsv history`): transactions, open requests,
  // policies, and rollup counts — one poll instead of three.
  property var transactions: []
  property var requests: []
  property var policies: []
  property var agents: []
  property var summary: ({ inFlight: 0, mined: 0, failed: 0, pendingRequests: 0, allowedOrigins: 0, deniedOrigins: 0 })

  function refresh() {
    if (!statusProc.running) statusProc.running = true;
  }

  function open() {
    refresh();
    if (typeof root.show === "function") root.show();
    else if (typeof root.toggle === "function" && !root.opened) root.toggle();
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
          if (!balanceProc.running) balanceProc.running = true;
          if (!historyProc.running) historyProc.running = true;
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
          if (h.summary) root.summary = h.summary;
        } catch (e) {
          root.transactions = [];
          root.requests = [];
          root.policies = [];
          root.agents = [];
        }
      }
    }
  }

  Process {
    id: actionProc
    property var args: []
    command: ["bsv"].concat(args)
    onExited: root.refresh()
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

  function lockNow() {
    if (actionProc.running) return;
    actionProc.args = ["lock"];
    actionProc.running = true;
  }

  ColumnLayout {
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
