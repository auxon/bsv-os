import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// BSV OS wallet pill for the Omarchy bar.
//
// Polls `bsv status` every 10s (plus `bsv balance` / `bsv pending` /
// `bsv requests` when a wallet exists) and shows lock state + balance.
// Left-click toggles the wallet panel (Panel.qml); right-click locks
// (`bsv lock`). New spend requests summon the panel like a system
// auth dialog.
BarWidget {
  id: root
  moduleName: "bsv.wallet"

  property bool hasWallet: false
  property bool locked: true
  property bool daemonUp: false
  property string balanceText: ""
  property int pendingCount: 0
  property int requestCount: 0
  property var seenRequestIds: []

  readonly property string stateText: {
    if (!daemonUp) return "₿ down";
    if (!hasWallet) return "₿ none";
    if (locked) return requestCount > 0 ? `₿ locked (${requestCount})` : "₿ locked";
    if (balanceText !== "") return `₿ ${balanceText}`;
    return "₿ ✓";
  }

  function refresh() {
    if (!statusProc.running) statusProc.running = true;
  }

  function lockNow() {
    if (!lockProc.running) lockProc.running = true;
  }

  function togglePanel() {
    if (panelLoader.item && typeof panelLoader.item.toggle === "function")
      panelLoader.item.toggle();
  }

  // Shape contract for shell.summon/hide/toggle routing:
  // Bar.findPanelWidget requires open/close/opened on the bar-widget root,
  // and Bar.requestPopout prefers closeForPopoutSwitch over close.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item) panelLoader.item.open();
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close();
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch();
  }

  function injectPanel() {
    var target = panelLoader.item;
    if (!target) return;
    if ("bar" in target) target.bar = root.bar;
    if ("settings" in target) target.settings = root.settings;
    if ("anchorItem" in target) target.anchorItem = button;
    if ("hostWidget" in target) target.hostWidget = root;
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

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
          if (root.hasWallet && !root.locked) {
            if (!balanceProc.running) balanceProc.running = true;
            if (!pendingProc.running) pendingProc.running = true;
          }
          if (root.hasWallet) {
            if (!requestsProc.running) requestsProc.running = true;
          }
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
          const sats = (b.confirmed ?? 0) + (b.unconfirmed ?? 0);
          root.balanceText = (sats / 1e8).toFixed(8);
        } catch (e) {
          // keep previous text
        }
      }
    }
  }

  Process {
    id: pendingProc
    command: ["bsv", "pending"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const p = JSON.parse(text);
          root.pendingCount = (p.tracked ?? []).length;
        } catch (e) {
          // keep previous count
        }
      }
    }
  }

  Process {
    id: requestsProc
    command: ["bsv", "requests"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          const reqs = r.requests ?? [];
          root.requestCount = reqs.length;
          const ids = reqs.map((q) => q.id);
          const fresh = ids.filter((id) => root.seenRequestIds.indexOf(id) === -1);
          root.seenRequestIds = ids;
          // PayPrompt behavior: a never-before-seen spend request
          // summons the approval panel like a system auth dialog.
          // reveal() refreshes then shows (never call open() here: the
          // Panel base routes toggle() through open()).
          if (fresh.length > 0 && panelLoader.item) {
            if (typeof panelLoader.item.reveal === "function") panelLoader.item.reveal();
            else if (typeof panelLoader.item.toggle === "function") panelLoader.item.toggle();
          }
        } catch (e) {
          // keep previous count
        }
      }
    }
  }

  Process {
    id: lockProc
    command: ["bsv", "lock"]
    onExited: () => root.refresh()
  }

  // 10s status poll: unlocks/locks should surface promptly on the pill.
  Timer {
    interval: 10000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: {
      if (root.hasWallet && !requestsProc.running) requestsProc.running = true;
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel();
      Qt.callLater(root.injectPanel);
    }
  }

  IpcHandler {
    target: "bsv.wallet"

    function refresh(): void { root.broadcast("refresh"); }
    function open(): void {
      if (!panelLoader.item) return;
      if (typeof panelLoader.item.reveal === "function") panelLoader.item.reveal();
      else if (typeof panelLoader.item.toggle === "function") panelLoader.item.toggle();
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.stateText
    labelVisible: !root.vertical
    hasVisualContent: text !== ""
    horizontalMargin: 8.75
    verticalPadding: 8.75
    tooltipText: root.daemonUp
      ? (root.hasWallet
        ? (root.locked ? "Wallet locked — click to review, right-click keeps it locked" : `Balance ${root.balanceText} BSV · ${root.pendingCount} pending`)
        : "No wallet enrolled — run `bsv create` in a terminal")
      : "bsv-walletd unreachable"
    active: root.requestCount > 0

    onPressed: function(b) {
      if (b === Qt.RightButton) root.lockNow();
      else root.togglePanel();
    }
  }
}
