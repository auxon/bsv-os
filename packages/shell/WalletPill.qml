// BSV OS — Quickshell wallet pill (scaffold).
//
// Bar widget showing wallet state. Data contract (finalize on-device against
// the installed shell's widget API):
//   - polls `bsv status` and `bsv pending` (both print JSON) every 30s
//   - locked (amber) / unlocked + balance (green) / no wallet (grey)
//   - click opens the wallet panel (PayPrompt.qml); right-click locks
//
// TODO(on-device): register in the shell's widget list per omarchy-mac's
// plugin docs (`shell.toml` surface), match bar theming tokens.

import QtQuick
import Quickshell
import Quickshell.Io

Rectangle {
  id: root
  width: pillRow.width + 20
  height: 30
  radius: 15
  // TODO(on-device): replace with shell theme tokens (e.g. Theme.bgAlt)
  color: "#221c33"
  border.color: stateColor
  border.width: 1

  property string stateColor: "#6b7280" // grey: unknown
  property string label: "bsv…"
  property bool locked: true

  Process {
    id: statusProc
    command: ["bsv", "status"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const s = JSON.parse(text);
          root.locked = !!s.locked;
          if (!s.hasWallet) {
            root.label = "bsv: none";
            root.stateColor = "#6b7280";
          } else if (s.locked) {
            root.label = "bsv: locked";
            root.stateColor = "#f59e0b";
          } else {
            root.label = "bsv ✓";
            root.stateColor = "#4ade80";
            balanceProc.running = true;
          }
        } catch (e) {
          root.label = "bsv: down";
          root.stateColor = "#ef4444";
        }
      }
    }
  }

  Process {
    id: balanceProc
    command: ["bsv", "balance"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const b = JSON.parse(text);
          const sats = (b.confirmed ?? 0) + (b.unconfirmed ?? 0);
          root.label = `bsv ${(sats / 1e8).toFixed(8)}`;
        } catch (e) {
          // keep the ✓ state
        }
      }
    }
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: statusProc.running = true
  }
  Component.onCompleted: statusProc.running = true

  Row {
    id: pillRow
    anchors.centerIn: parent
    spacing: 6
    Text {
      text: "₿"
      color: root.stateColor
      font.pixelSize: 14
      font.bold: true
    }
    Text {
      text: root.label
      color: "#f1eefb"
      font.pixelSize: 12
    }
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: (mouse) => {
      // TODO(on-device): left opens PayPrompt panel, right locks (`bsv lock` + refresh)
    }
  }
}
