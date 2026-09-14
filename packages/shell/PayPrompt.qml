// BSV OS — pay/approval prompt (scaffold).
//
// Shown when an app requests spending the policy engine hasn't approved:
// origin, action, amount, Approve (optional cap) / Deny. Wires to
// `bsv requests`, `bsv allow <origin> [cap]`, `bsv deny <origin>`.
//
// TODO(on-device): hook into the shell's notification/polkit surface so
// prompts appear like system auth dialogs, with fingerprint offer where
// Quattro exposes it.

import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io

Rectangle {
  id: root
  width: 360
  height: col.height + 32
  radius: 16
  color: "#221c33"
  border.color: "#7c5cff"
  border.width: 1
  visible: false

  property string reqOrigin: ""
  property string reqAction: ""
  property int reqAmount: 0

  function promptFor(origin, action, amount) {
    reqOrigin = origin;
    reqAction = action;
    reqAmount = amount;
    visible = true;
  }

  // TODO(on-device): poll `bsv requests` and call promptFor() on new rows.
  Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: {
      // TODO: fetch pending requests; prompt on first unseen id
    }
  }

  ColumnLayout {
    id: col
    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 16 }
    spacing: 8
    Text { text: "Wallet approval"; color: "#f1eefb"; font.pixelSize: 16; font.bold: true }
    Text { text: `${root.reqOrigin} wants to ${root.reqAction} · ${root.reqAmount} sats`; color: "#a79fc4"; font.pixelSize: 13; wrapMode: Text.Wrap }
    RowLayout {
      spacing: 8
      Rectangle {
        Layout.fillWidth: true; height: 40; radius: 10; color: "#7c5cff"
        Text { anchors.centerIn: parent; text: "Approve"; color: "white"; font.bold: true }
        MouseArea { anchors.fill: parent; onClicked: approveProc.running = true }
      }
      Rectangle {
        Layout.fillWidth: true; height: 40; radius: 10; color: "#2c2545"; border.color: "#37304d"; border.width: 1
        Text { anchors.centerIn: parent; text: "Deny"; color: "#f1eefb" }
        MouseArea { anchors.fill: parent; onClicked: denyProc.running = true }
      }
    }
  }

  Process {
    id: approveProc
    command: ["bsv", "allow", root.reqOrigin]
    onExited: (code) => { if (code === 0) root.visible = false; }
  }
  Process {
    id: denyProc
    command: ["bsv", "deny", root.reqOrigin]
    onExited: root.visible = false
  }
}
