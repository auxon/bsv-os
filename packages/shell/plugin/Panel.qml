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
  property string qrDataUrl: ""
  property string qrAddress: ""
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
  property string msgPeer: ""
  // F6.2 direct channel (see `bsv p2p peers`): LAN-discovered wallets.
  // Addresses are runtime only; sending prefers a live direct peer.
  property var peers: []
  property bool p2pEnabled: false
  property string msgTo: ""
  property string msgBody: ""
  property string msgSendText: ""
  property bool msgSendOk: true
  // People: local names for keys + receive addresses (see `bsv contact`).
  property var contacts: []
  property string myName: ""
  // One-tap pay (see `bsv pay`): sats to a person, note rides as a DM.
  property string payWho: ""
  property string paySats: ""
  property string payNote: ""
  property string payText: ""
  property bool payOk: true
  // First-run faucet (see `bsv faucet`): one claim per identity key.
  property bool faucetFunded: false
  property int faucetAmount: 0
  property bool faucetClaimed: false
  property string faucetText: ""
  // F6.3 files (see `bsv torrent`): BitTorrent shares with bsvOS discovery.
  property var torrents: []
  property bool torrentEnabled: false
  property int torrentPort: 0
  property string torrentPath: ""
  property string torrentPeer: ""
  property string torrentText: ""
  property bool torrentOk: true
  // Payment requests (see `bsv request`): signed asks that can travel over
  // DM, QR, or paste. Approving pays through the normal policy gate.
  property var requestsIn: []
  property var requestsOut: []
  property string reqWho: ""
  property string reqSats: ""
  property string reqMemo: ""
  property string reqText: ""
  property bool reqOk: true
  property string reqQr: ""
  property string reqCode: ""
  // Inscribed purchase receipts (see `bsv receipt`): 1Sat ordinals delivered
  // to the counterparty, signed by this wallet's identity key.
  property var receipts: []
  property string receiptText: ""
  property bool receiptOk: true
  property var receiptDetail: ({})
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
          if (!p2pPeersProc.running) p2pPeersProc.running = true;
          if (!contactsProc.running) contactsProc.running = true;
          if (!profileProc.running) profileProc.running = true;
          if (!faucetStatusProc.running) faucetStatusProc.running = true;
          if (!torrentListProc.running) torrentListProc.running = true;
          if (!requestsProc.running) requestsProc.running = true;
          if (!receiptsProc.running) receiptsProc.running = true;
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
          // QR is static per address: fetch once, refetch on rotation.
          if (!qrProc.running && root.address !== "" && root.qrAddress !== root.address) qrProc.running = true;
        } catch (e) {
          // daemon may be locked or walletless; panel shows state rows
        }
      }
    }
  }

  Process {
    id: qrProc
    command: ["bsv", "address", "--png"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const q = JSON.parse(text);
          root.qrAddress = q.address ?? "";
          root.qrDataUrl = q.dataUrl ?? "";
        } catch (e) {
          root.qrDataUrl = "";
        }
      }
    }
  }

  Process {
    id: copyProc
    property string copyText: ""
    command: ["wl-copy", copyText]
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

  // F6.2 peer discovery list: runtime only (beacons, not persisted).
  Process {
    id: p2pPeersProc
    command: ["bsv", "p2p", "peers"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.p2pEnabled = !!r.enabled;
          root.peers = r.peers ?? [];
        } catch (e) {
          root.p2pEnabled = false;
          root.peers = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) { root.p2pEnabled = false; root.peers = []; } }
  }

  // People + profile: local names bound to keys and receive addresses.
  Process {
    id: contactsProc
    command: ["bsv", "contact", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.contacts = JSON.parse(text).contacts ?? [];
        } catch (e) {
          root.contacts = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.contacts = []; }
  }

  Process {
    id: profileProc
    command: ["bsv", "me"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.myName = JSON.parse(text).name ?? "";
        } catch (e) {
          root.myName = "";
        }
      }
    }
  }

  Process {
    id: profileSetProc
    property string name: ""
    command: ["bsv", "me", name]
    onExited: root.refresh()
  }

  Process {
    id: contactAddProc
    property string name: ""
    property string key: ""
    property string address: ""
    command: ["bsv", "contact", "add", name, key].concat(address.trim() === "" ? [] : [address])
    onExited: root.refresh()
  }

  // One-tap pay: `bsv pay <@name|key|address> <sats> [--note=..]`. Sats go
  // to the person's receive address; the note rides as an encrypted DM when
  // the person has an identity key. Payment is never rolled back by a
  // failed note — the result says which happened.
  Process {
    id: payProc
    property string who: ""
    property int sats: 0
    property string note: ""
    command: ["bsv", "pay", who, String(sats)].concat(note.trim() === "" ? [] : ["--note", note])
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.payOk = true;
          const name = r.to && r.to.display ? r.to.display : who;
          root.payText = `Paid ${sats} sats to ${name}${r.messageSent ? " with your note" : ""}.`;
          root.paySats = "";
          root.payNote = "";
          if (!msgListProc.running) msgListProc.running = true;
          if (!balanceProc.running) balanceProc.running = true;
          if (!historyProc.running) historyProc.running = true;
        } catch (e) {
          root.payOk = false;
          root.payText = "Pay failed — see the terminal for the policy reason.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.payOk = false;
        root.payText = "Pay failed — unknown person, no address, or policy denied.";
      }
    }
  }

  // F6.3 files: list, share a path, fetch an infohash (peer optional).
  Process {
    id: torrentListProc
    command: ["bsv", "torrent", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.torrentEnabled = !!r.enabled;
          root.torrentPort = Number(r.port) || 0;
          root.torrents = r.torrents ?? [];
        } catch (e) {
          root.torrentEnabled = false;
          root.torrents = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) { root.torrentEnabled = false; root.torrents = []; } }
  }

  Process {
    id: torrentSeedProc
    property string path: ""
    command: ["bsv", "torrent", "seed", path]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.torrentOk = true;
          root.torrentText = `Sharing ${r.name} (${String(r.infoHash).slice(0, 12)}…) — wallets on your network can fetch it.`;
          root.torrentPath = "";
        } catch (e) {
          root.torrentOk = false;
          root.torrentText = "Share failed — check the path.";
        }
        if (!torrentListProc.running) torrentListProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.torrentOk = false;
        root.torrentText = "Share failed — file missing, empty, or over 16 GiB.";
      }
    }
  }

  Process {
    id: torrentFetchProc
    property string source: ""
    property string peer: ""
    command: ["bsv", "torrent", "fetch", source].concat(peer.trim() === "" ? [] : ["--peer", peer.trim()])
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.torrentOk = true;
          root.torrentText = `Fetched ${r.name} → ${r.path}`;
          root.torrentPeer = "";
        } catch (e) {
          root.torrentOk = false;
          root.torrentText = "Fetch failed — see the terminal for the reason.";
        }
        if (!torrentListProc.running) torrentListProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.torrentOk = false;
        root.torrentText = "Fetch failed — no peer found, or the torrent is unknown.";
      }
    }
  }

  // Payment requests: sync + list, create, approve, decline, show code/QR.
  Process {
    id: requestsProc
    command: ["bsv", "request", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.requestsIn = r.incoming ?? [];
          root.requestsOut = r.outgoing ?? [];
        } catch (e) {
          root.requestsIn = [];
          root.requestsOut = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) { root.requestsIn = []; root.requestsOut = []; } }
  }

  Process {
    id: requestCreateProc
    property string who: ""
    property int sats: 0
    property string memo: ""
    command: ["bsv", "request", who, String(sats)].concat(memo.trim() === "" ? [] : ["--memo", memo])
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.reqOk = true;
          root.reqText = r.sent
            ? `Request for ${r.amount} sats sent — awaiting payment.`
            : "Request ready — share the code below (no identity key known for a DM).";
          root.reqQr = r.dataUrl ?? "";
          root.reqCode = r.code ?? "";
          root.reqSats = "";
          root.reqMemo = "";
        } catch (e) {
          root.reqOk = false;
          root.reqText = "Could not create the request.";
        }
        if (!requestsProc.running) requestsProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.reqOk = false;
        root.reqText = "Request failed — unknown person or bad amount.";
      }
    }
  }

  Process {
    id: requestPayProc
    property string id: ""
    command: ["bsv", "request", "pay", id]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.reqOk = true;
          root.reqText = `Paid ${r.amount} sats (${String(r.txid).slice(0, 12)}…)${r.receiptSent ? " — receipt sent" : ""}.`;
        } catch (e) {
          root.reqOk = false;
          root.reqText = "Payment failed.";
        }
        root.reqQr = "";
        root.reqCode = "";
        if (!requestsProc.running) requestsProc.running = true;
        if (!balanceProc.running) balanceProc.running = true;
        if (!historyProc.running) historyProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.reqOk = false;
        root.reqText = "Payment failed — expired, declined, already paid, or policy denied.";
      }
    }
  }

  Process {
    id: requestCodeProc
    property string id: ""
    command: ["bsv", "request", "code", id]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.reqQr = r.dataUrl ?? "";
          root.reqCode = r.code ?? "";
          root.reqOk = true;
          root.reqText = `Code for ${String(r.id).slice(0, 8)}… (${r.status}) — copy or scan.`;
        } catch (e) {
          root.reqOk = false;
          root.reqText = "Could not load the request code.";
        }
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.reqOk = false;
        root.reqText = "Could not load the request code.";
      }
    }
  }

  // Receipts: list inscribed purchase receipts, issue one for a paid request.
  Process {
    id: receiptsProc
    command: ["bsv", "receipt", "list"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.receipts = JSON.parse(text).receipts ?? [];
        } catch (e) {
          root.receipts = [];
        }
      }
    }
    onExited: (code) => { if (code !== 0) root.receipts = []; }
  }

  Process {
    id: receiptIssueProc
    property string request: ""
    command: ["bsv", "receipt", "issue", "--request", request]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.receiptOk = true;
          root.receiptText = `Receipt inscribed and delivered: ${String(r.outpoint ?? "").slice(0, 12)}…`;
        } catch (e) {
          root.receiptOk = false;
          root.receiptText = "Receipt failed — see the terminal.";
        }
        if (!receiptsProc.running) receiptsProc.running = true;
        if (!requestsProc.running) requestsProc.running = true;
        if (!ordProc.running) ordProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.receiptOk = false;
        root.receiptText = "Receipt failed — only paid incoming requests can be receipted.";
      }
    }
  }

  // Show the inscribed NFT: `bsv receipt show <id>` decodes and verifies it.
  Process {
    id: receiptShowProc
    property string id: ""
    command: ["bsv", "receipt", "show", id]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          root.receiptDetail = JSON.parse(text);
        } catch (e) {
          root.receiptDetail = ({});
        }
      }
    }
  }

  Process {
    id: openUrlProc
    property string url: ""
    command: ["xdg-open", url]
  }

  // First-run faucet: status on every refresh, claim on tap.
  Process {
    id: faucetStatusProc
    command: ["bsv", "faucet", "status"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.faucetFunded = !!r.funded;
          root.faucetAmount = Number(r.amount) || 0;
          root.faucetClaimed = !!r.claimed;
        } catch (e) {
          root.faucetFunded = false;
        }
      }
    }
  }

  Process {
    id: faucetClaimProc
    command: ["bsv", "faucet", "claim"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.faucetClaimed = true;
          root.faucetText = `Starter sats on the way — ${Number(r.amount) || 0} sats to ${String(r.address ?? "").slice(0, 10)}… The balance updates when it confirms.`;
        } catch (e) {
          root.faucetText = "Claim failed — try again in a moment.";
        }
        if (!balanceProc.running) balanceProc.running = true;
        if (!historyProc.running) historyProc.running = true;
        if (!faucetStatusProc.running) faucetStatusProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) root.faucetText = "Claim failed — already claimed, or the faucet is unreachable.";
    }
  }

  // Compose runner: `bsv msg send <identityKey> --text <msg>` uses the
  // direct channel when the peer is live, otherwise the relay. The body
  // never touches argv history: Process passes it as its own argument.
  Process {
    id: msgSendProc
    property string to: ""
    property string body: ""
    command: ["bsv", "msg", "send", to, "--text", body]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          const r = JSON.parse(text);
          root.msgSendOk = true;
          root.msgSendText = `Sent via ${r.transport === "p2p" ? "direct channel" : "relay"} (${String(r.id ?? "").slice(0, 12)}…).`;
          root.msgBody = "";
        } catch (e) {
          root.msgSendOk = false;
          root.msgSendText = "Send failed — is the wallet unlocked?";
        }
        if (!msgSyncProc.running) msgSyncProc.running = true;
        if (!msgListProc.running) msgListProc.running = true;
      }
    }
    onExited: (code) => {
      if (code !== 0) {
        root.msgSendOk = false;
        root.msgSendText = "Send failed — is the wallet unlocked? Check the identity key.";
      }
    }
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
          root.msgPeer = r.peer ?? "";
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
  // guard (exactly the one-app-at-a-time symptom). A transient user SERVICE
  // detaches the opener; `--scope` must NOT be used — it waits for the
  // command and blocks the panel again. The CLI keeps supervising its
  // bridge/window pair and the unit ends with it. The panel stops waiting.
  Process {
    id: openProc
    property string domain: ""
    command: ["systemd-run", "--user", "--quiet", "--collect", "bsv", "app", "open", domain]
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

  // Human send from the Send section: address + sats typed explicitly is
  // the confirmation; the daemon policy-gates and the tx lands in history.
  function sendTo(address, sats) {
    if (actionProc.running) return;
    actionProc.args = ["send", address, String(Math.max(1, Math.floor(Number(sats) || 0)))];
    actionProc.running = true;
  }

  // One-tap allowance: mint an F9 sub-wallet for the requesting origin
  // (budget + a daily tenth, 30d expiry) instead of a blanket allow —
  // the mint is the approval ceremony, and routine spends then pass
  // without waking the human again.
  function mintBudget(origin, budgetSats) {
    if (actionProc.running) return;
    const budget = Math.max(1, Math.floor(Number(budgetSats) || 0));
    actionProc.args = ["agent", "mint", origin, `--budget=${budget}`, `--daily=${Math.max(1, Math.floor(budget / 10))}`, "--expiry=30d"];
    actionProc.running = true;
  }

  function fmtSats(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v >= 1000000) return `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
    return `${v}`;
  }

  function fmtDate(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return "";
    try {
      return new Date(n).toISOString().slice(0, 10);
    } catch (e) {
      return "";
    }
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
        ColumnLayout {
          spacing: 4
          Layout.fillWidth: true
          property bool showBudget: false
          property int reqAmount: Math.max(0, Math.floor(Number(modelData.amount_sats ?? 0)))

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
              text: "Budget…"
              visible: reqAmount > 0
              onClicked: showBudget = !showBudget
            }

            Button {
              text: "Deny"
              onClicked: root.deny(modelData.origin)
            }
          }

          RowLayout {
            spacing: 8
            Layout.fillWidth: true
            visible: showBudget && reqAmount > 0

            Text {
              text: `Allowance · 30d, daily = budget ÷ 10:`
              color: Color.muted
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
              Layout.fillWidth: true
            }

            Button {
              text: `10× ${root.fmtSats(reqAmount * 10)}`
              onClicked: root.mintBudget(modelData.origin, reqAmount * 10)
            }

            Button {
              text: `100× ${root.fmtSats(reqAmount * 100)}`
              onClicked: root.mintBudget(modelData.origin, reqAmount * 100)
            }

            Button {
              text: `1000× ${root.fmtSats(reqAmount * 1000)}`
              onClicked: root.mintBudget(modelData.origin, reqAmount * 1000)
            }
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
              text: `${modelData.name ?? "?"} · ${modelData.remaining ?? 0}/${modelData.budget_sats ?? 0} sats${(modelData.daily_sats ?? 0) > 0 ? ` · ${modelData.window_remaining ?? 0}/${modelData.daily_sats} today` : ""}${(modelData.expiry_at ?? 0) > 0 ? ` · expires ${new Date(modelData.expiry_at).toLocaleDateString()}` : ""} · ${modelData.active ? "active" : (modelData.revoked ? "revoked" : "expired")}`
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

    PanelSectionHeader { text: "Receive" }

    ColumnLayout {
      spacing: 8
      Layout.fillWidth: true
      visible: root.address !== ""

      Text {
        text: root.address
        color: Color.foreground
        font.pixelSize: Style.font.body
        font.family: "monospace"
        wrapMode: Text.WrapAnywhere
        Layout.fillWidth: true
      }

      RowLayout {
        spacing: 8
        Layout.fillWidth: true

        Image {
          source: root.qrDataUrl
          width: 200
          height: 200
          fillMode: Image.PreserveAspectFit
          visible: root.qrDataUrl !== ""
        }

        Button {
          text: "Copy"
          onClicked: {
            copyProc.copyText = root.address;
            if (!copyProc.running) copyProc.running = true;
          }
        }
      }
    }

    Text {
      text: "No address — unlock the wallet to receive."
      color: Color.muted
      font.pixelSize: Style.font.body
      visible: root.address === ""
    }

    PanelSectionHeader { text: "Send" }

    ColumnLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: sendAddressField
        placeholderText: "Destination address"
        font.family: "monospace"
        Layout.fillWidth: true
      }

      TextField {
        id: sendSatsField
        placeholderText: "Amount in sats"
        inputMethodHints: Qt.ImhDigitsOnly
        Layout.fillWidth: true
      }

      RowLayout {
        spacing: 8
        Layout.fillWidth: true

        Button {
          text: "Send"
          enabled: sendAddressField.text.trim() !== "" && Number(sendSatsField.text) > 0
          onClicked: root.sendTo(sendAddressField.text.trim(), Math.floor(Number(sendSatsField.text)))
        }
      }

      Text {
        text: "Policy-gated like everything else — the tx lands in Transactions above, failures print to the terminal (`bsv send`)."
        color: Color.muted
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
        Layout.fillWidth: true
      }
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

    PanelSectionHeader { text: "Market" }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      Text {
        text: "Atomic Market — browse listings, buy ordinals and tokens (payment + asset in one tx), list your own. Installed BRC-100 app."
        color: Color.muted
        font.pixelSize: Style.font.body
        wrapMode: Text.Wrap
        Layout.fillWidth: true
      }

      Button {
        text: "Open"
        onClicked: root.openApp("market.entangleit.com")
      }
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

    PanelSectionHeader { text: `People (${root.contacts.length})` }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: myNameField
        placeholderText: root.myName !== "" ? `You announce as “${root.myName}” — change` : "Your name on the network"
        text: ""
        onAccepted: {
          if (text.trim() !== "") {
            profileSetProc.name = text.trim();
            profileSetProc.running = true;
          }
        }
        Layout.fillWidth: true
      }

      Button {
        text: "Save"
        enabled: myNameField.text.trim() !== "" && !profileSetProc.running
        onClicked: {
          profileSetProc.name = myNameField.text.trim();
          profileSetProc.running = true;
        }
      }
    }

    ColumnLayout {
      spacing: 6
      visible: root.contacts.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.contacts
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.display ?? modelData.name}${modelData.address ? " · " + String(modelData.address).slice(0, 10) + "…" : " · no address yet"}`
            color: Color.foreground
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "Message"
            onClicked: root.msgTo = String(modelData.identityKey)
          }

          Button {
            text: "Pay"
            onClicked: root.payWho = `@${modelData.name}`
          }
        }
      }
    }

    Text {
      text: "No people yet — add someone by name, or message a nearby peer first and save them."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.contacts.length === 0
    }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: contactNameField
        placeholderText: "name"
        Layout.fillWidth: true
      }

      TextField {
        id: contactKeyField
        placeholderText: "identity key (66 hex)"
        font.family: "monospace"
        Layout.fillWidth: true
      }

      TextField {
        id: contactAddrField
        placeholderText: "address (optional)"
        font.family: "monospace"
        Layout.fillWidth: true
      }

      Button {
        text: "Add"
        enabled: contactNameField.text.trim() !== "" && contactKeyField.text.trim() !== "" && !contactAddProc.running
        onClicked: {
          contactAddProc.name = contactNameField.text.trim();
          contactAddProc.key = contactKeyField.text.trim();
          contactAddProc.address = contactAddrField.text.trim();
          contactAddProc.running = true;
          contactNameField.text = "";
          contactKeyField.text = "";
          contactAddrField.text = "";
        }
      }
    }

    PanelSectionHeader { text: `Inbox (${root.messages.length})` }

    Text {
      text: "ECDH direct messages. Ciphertext at rest — Read decrypts, Ack clears. Sends go direct to nearby peers, otherwise over the encrypted relay."
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
            text: `${modelData.direction === "out" ? "→" : "←"} ${String(modelData.peer ?? "?").slice(0, 12)}… · ${modelData.transport === "p2p" ? "direct" : modelData.transport === "local" ? "note to self" : "relay"}${modelData.acked ? "" : " · new"}`
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
            text: "Reply"
            visible: /^[0-9a-fA-F]{66}$/.test(String(modelData.peer ?? ""))
            onClicked: root.msgTo = String(modelData.peer)
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
      text: "No messages — message a nearby peer below, or paste any identity key into Compose."
      color: Color.muted
      font.pixelSize: Style.font.body
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.messages.length === 0
    }

    PanelSectionHeader { text: `Nearby peers (${root.peers.length})` }

    Text {
      text: root.p2pEnabled
        ? "Wallets broadcasting on this network. Direct sends need no relay; both sides must be unlocked."
        : "Direct channel off — messages use the relay. Enable by starting the daemon without BSV_P2P=0."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 6
      visible: root.peers.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.peers
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.online ? "●" : "○"} ${modelData.nameVerified && modelData.name ? modelData.name + " · " : ""}${String(modelData.identityKey ?? "?").slice(0, 12)}… · ${modelData.address ?? "?"}:${modelData.port ?? "?"}`
            color: modelData.online ? Color.foreground : Color.muted
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "Message"
            enabled: modelData.online
            onClicked: root.msgTo = String(modelData.identityKey)
          }

          Button {
            text: "Pay"
            enabled: modelData.online && (modelData.payTo ?? "") !== ""
            onClicked: root.payWho = String(modelData.identityKey)
          }

          Button {
            text: "Save"
            visible: !!modelData.nameVerified && modelData.name !== ""
            onClicked: {
              contactAddProc.name = modelData.name;
              contactAddProc.key = modelData.identityKey;
              contactAddProc.address = modelData.payTo ?? "";
              contactAddProc.running = true;
            }
          }
        }
      }
    }

    PanelSectionHeader { text: "Compose" }

    ColumnLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: msgToField
        placeholderText: "Recipient: @name, identity key, or tap a peer"
        font.family: "monospace"
        text: root.msgTo
        onTextEdited: root.msgTo = text
        Layout.fillWidth: true
      }

      TextField {
        id: msgBodyField
        placeholderText: "Message"
        text: root.msgBody
        onTextEdited: root.msgBody = text
        onAccepted: {
          if (root.msgTo.trim() !== "" && root.msgBody.trim() !== "" && !msgSendProc.running) {
            msgSendProc.to = root.msgTo.trim();
            msgSendProc.body = root.msgBody;
            msgSendProc.running = true;
          }
        }
        Layout.fillWidth: true
      }

      RowLayout {
        spacing: 8
        Layout.fillWidth: true

        Button {
          text: "Send"
          enabled: root.msgTo.trim() !== "" && root.msgBody.trim() !== "" && !msgSendProc.running
          onClicked: {
            msgSendProc.to = root.msgTo.trim();
            msgSendProc.body = root.msgBody;
            msgSendProc.running = true;
          }
        }

        Text {
          text: root.msgSendText
          color: root.msgSendOk ? Color.muted : Color.urgent
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
          Layout.fillWidth: true
          visible: root.msgSendText !== ""
        }
      }
    }

    PanelSectionHeader { text: "Pay someone" }

    Text {
      text: "Sats to a person, with the note sent encrypted when they have an identity key. Addresses are learned from nearby peers, never derived from keys."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: payWhoField
        placeholderText: "@name, identity key, or address"
        font.family: "monospace"
        text: root.payWho
        onTextEdited: root.payWho = text
        Layout.fillWidth: true
      }

      RowLayout {
        spacing: 8
        Layout.fillWidth: true

        TextField {
          id: paySatsField
          placeholderText: "sats"
          inputMethodHints: Qt.ImhDigitsOnly
          text: root.paySats
          onTextEdited: root.paySats = text
          Layout.fillWidth: true
        }

        Button {
          text: "Pay"
          enabled: Number(root.paySats) > 0 && root.payWho.trim() !== "" && !payProc.running
          onClicked: {
            payProc.who = root.payWho.trim();
            payProc.sats = Math.max(1, Math.floor(Number(root.paySats) || 0));
            payProc.note = root.payNote;
            payProc.running = true;
          }
        }
      }

      TextField {
        id: payNoteField
        placeholderText: "note (optional, sent as an encrypted DM)"
        text: root.payNote
        onTextEdited: root.payNote = text
        Layout.fillWidth: true
      }

      Text {
        text: root.payText
        color: root.payOk ? Color.muted : Color.urgent
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
        Layout.fillWidth: true
        visible: root.payText !== ""
      }
    }

    PanelSectionHeader { text: "Payment requests" }

    Text {
      text: "Ask anyone for sats (or pay an ask): the request is signed by your identity key, so it is safe over DM, QR, or a pasted message. Nothing is auto-paid."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 6
      visible: root.requestsIn.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.requestsIn
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `← ${modelData.amount} sats${modelData.memo ? " · " + modelData.memo : ""} · ${modelData.status}`
            color: modelData.status === "pending" ? Color.foreground : Color.muted
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "Approve"
            visible: modelData.status === "pending"
            onClicked: {
              requestPayProc.id = modelData.id;
              requestPayProc.running = true;
            }
          }

          Button {
            text: "Decline"
            visible: modelData.status === "pending"
            onClicked: root.runAppAction(["request", "decline", modelData.id])
          }

          Button {
            text: "Receipt"
            visible: modelData.status === "paid" && !receiptIssueProc.running
            onClicked: {
              receiptIssueProc.request = modelData.id;
              receiptIssueProc.running = true;
            }
          }
        }
      }
    }

    ColumnLayout {
      spacing: 6
      visible: root.requestsOut.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.requestsOut
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `→ ${modelData.amount} sats${modelData.memo ? " · " + modelData.memo : ""} · ${modelData.status}`
            color: Color.muted
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "Show code"
            onClicked: {
              requestCodeProc.id = modelData.id;
              requestCodeProc.running = true;
            }
          }
        }
      }
    }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: reqWhoField
        placeholderText: "@name, identity key, or address"
        font.family: "monospace"
        text: root.reqWho
        onTextEdited: root.reqWho = text
        Layout.fillWidth: true
      }

      TextField {
        id: reqSatsField
        placeholderText: "sats"
        inputMethodHints: Qt.ImhDigitsOnly
        text: root.reqSats
        onTextEdited: root.reqSats = text
        Layout.fillWidth: true
      }

      TextField {
        id: reqMemoField
        placeholderText: "memo"
        text: root.reqMemo
        onTextEdited: root.reqMemo = text
        Layout.fillWidth: true
      }

      Button {
        text: "Request"
        enabled: root.reqWho.trim() !== "" && Number(root.reqSats) > 0 && !requestCreateProc.running
        onClicked: {
          requestCreateProc.who = root.reqWho.trim();
          requestCreateProc.sats = Math.max(1, Math.floor(Number(root.reqSats) || 0));
          requestCreateProc.memo = root.reqMemo;
          requestCreateProc.running = true;
        }
      }
    }

    Text {
      text: root.reqText
      color: root.reqOk ? Color.muted : Color.urgent
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.reqText !== ""
    }

    RowLayout {
      spacing: 8
      visible: root.reqQr !== ""
      Layout.fillWidth: true

      Image {
        source: root.reqQr
        width: 160
        height: 160
        fillMode: Image.PreserveAspectFit
      }

      ColumnLayout {
        spacing: 4
        Layout.fillWidth: true

        Text {
          text: root.reqCode
          color: Color.muted
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
          Layout.fillWidth: true
        }

        Button {
          text: "Copy code"
          onClicked: {
            copyProc.copyText = root.reqCode;
            if (!copyProc.running) copyProc.running = true;
          }
        }
      }
    }

    PanelSectionHeader { text: `Receipts (${root.receipts.length})` }

    Text {
      text: "Purchase receipts inscribed as 1Sat ordinals and delivered to the seller in the same transaction — signed by your identity key, provable by anyone."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 6
      visible: root.receipts.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.receipts
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.amount} sats${modelData.memo ? " · " + modelData.memo : ""} · ${String(modelData.id).slice(0, 12)}…`
            color: Color.muted
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "View NFT"
            onClicked: {
              receiptShowProc.id = modelData.id;
              receiptShowProc.running = true;
            }
          }

          Button {
            text: "Copy id"
            onClicked: {
              copyProc.copyText = `${modelData.id}:0`;
              if (!copyProc.running) copyProc.running = true;
            }
          }
        }
      }
    }

    // Receipt NFT detail: the inscribed payload, decoded and verified.
    ColumnLayout {
      spacing: 4
      visible: root.receiptDetail !== undefined && root.receiptDetail.outpoint !== undefined
      Layout.fillWidth: true

      Text {
        text: root.receiptDetail.payload
          ? `Receipt NFT · ${root.receiptDetail.payload.amount} sats`
          : "Receipt NFT · payload unreadable"
        color: Color.foreground
        font.pixelSize: Style.font.body
        font.bold: true
        Layout.fillWidth: true
      }

      Text {
        text: root.receiptDetail.payload && root.receiptDetail.payload.memo
          ? root.receiptDetail.payload.memo
          : "(no memo)"
        color: Color.muted
        font.pixelSize: Style.font.body
        wrapMode: Text.Wrap
        Layout.fillWidth: true
      }

      Text {
        text: root.receiptDetail.payload
          ? `${String(root.receiptDetail.payload.from).slice(0, 12)}… → ${String(root.receiptDetail.payload.to).slice(0, 12)}… · ${fmtDate(root.receiptDetail.payload.at)}`
          : ""
        color: Color.muted
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
        Layout.fillWidth: true
      }

      Text {
        text: root.receiptDetail.verified ? "✓ signature valid" : "✗ signature INVALID"
        color: root.receiptDetail.verified ? Color.foreground : Color.urgent
        font.pixelSize: Style.font.caption
        Layout.fillWidth: true
      }

      Text {
        text: `carrier ${root.receiptDetail.outpoint}`
        color: Color.muted
        font.family: "monospace"
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
        Layout.fillWidth: true
      }

      RowLayout {
        spacing: 8
        Layout.fillWidth: true

        Button {
          text: "Copy outpoint"
          onClicked: {
            copyProc.copyText = root.receiptDetail.outpoint;
            if (!copyProc.running) copyProc.running = true;
          }
        }

        Button {
          text: "Copy payment txid"
          onClicked: {
            copyProc.copyText = root.receiptDetail.paymentTxid;
            if (!copyProc.running) copyProc.running = true;
          }
        }

        Button {
          text: "Open on-chain"
          onClicked: {
            openUrlProc.url = root.receiptDetail.explorer;
            openUrlProc.running = true;
          }
        }

        Button {
          text: "View in 1Sat Indexer"
          onClicked: {
            openUrlProc.url = root.receiptDetail.indexer;
            openUrlProc.running = true;
          }
        }
      }
    }

    Text {
      text: root.receiptText
      color: root.receiptOk ? Color.muted : Color.urgent
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.receiptText !== ""
    }

    PanelSectionHeader { text: "Starter sats" }

    Text {
      text: root.faucetClaimed
        ? "Claimed — one claim per wallet. This is for trying things: anchors, DMs, a first payment."
        : root.faucetFunded
          ? `A one-time faucet claim (${root.faucetAmount || "?"} sats) is available for this wallet.`
          : "Faucet unavailable right now — keep using the wallet; testnet-style starter sats are optional."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      Button {
        text: root.faucetClaimed ? "Claimed" : "Claim starter sats"
        enabled: root.faucetFunded && !root.faucetClaimed && !faucetClaimProc.running
        onClicked: faucetClaimProc.running = true
      }

      Text {
        text: root.faucetText
        color: Color.muted
        font.pixelSize: Style.font.caption
        wrapMode: Text.Wrap
        Layout.fillWidth: true
        visible: root.faucetText !== ""
      }
    }

    PanelSectionHeader { text: `Files (${root.torrents.length})` }

    Text {
      text: root.torrentEnabled
        ? `BitTorrent shares, discovered through bsvOS — no tracker. ${root.torrentPort ? "Serving on port " + root.torrentPort + ". " : ""}Fetched files land in ~/.local/share/bsv-os/torrents.`
        : "File sharing disabled (port busy or BSV_TORRENT=0)."
      color: Color.muted
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
    }

    ColumnLayout {
      spacing: 6
      visible: root.torrents.length > 0
      Layout.fillWidth: true

      Repeater {
        model: root.torrents
        RowLayout {
          spacing: 8
          Layout.fillWidth: true

          Text {
            text: `${modelData.direction === "seed" ? "↗" : "↘"} ${modelData.name} · ${modelData.length >= 1048576 ? (modelData.length / 1048576).toFixed(1) + " MiB" : Math.max(1, Math.round(modelData.length / 1024)) + " KiB"} · ${modelData.status}${modelData.detail ? " · " + modelData.detail : ""}`
            color: modelData.status === "error" ? Color.urgent : Color.foreground
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            Layout.fillWidth: true
          }

          Button {
            text: "Copy"
            onClicked: {
              copyProc.copyText = modelData.infoHash;
              if (!copyProc.running) copyProc.running = true;
            }
          }

          Button {
            text: "Stop"
            onClicked: root.runAppAction(["torrent", "remove", modelData.infoHash])
          }
        }
      }
    }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: torrentPathField
        placeholderText: "File to share (path under your home)"
        text: root.torrentPath
        onTextEdited: root.torrentPath = text
        Layout.fillWidth: true
      }

      Button {
        text: "Share"
        enabled: root.torrentPath.trim() !== "" && root.torrentEnabled && !torrentSeedProc.running
        onClicked: {
          torrentSeedProc.path = root.torrentPath.trim();
          torrentSeedProc.running = true;
        }
      }
    }

    RowLayout {
      spacing: 8
      Layout.fillWidth: true

      TextField {
        id: torrentFetchField
        placeholderText: "infohash to fetch"
        font.family: "monospace"
        Layout.fillWidth: true
      }

      TextField {
        id: torrentPeerField
        placeholderText: "peer host:port (optional)"
        text: root.torrentPeer
        onTextEdited: root.torrentPeer = text
        Layout.fillWidth: true
      }

      Button {
        text: "Fetch"
        enabled: torrentFetchField.text.trim() !== "" && root.torrentEnabled && !torrentFetchProc.running
        onClicked: {
          torrentFetchProc.source = torrentFetchField.text.trim();
          torrentFetchProc.peer = root.torrentPeer;
          torrentFetchProc.running = true;
        }
      }
    }

    Text {
      text: root.torrentText
      color: root.torrentOk ? Color.muted : Color.urgent
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
      visible: root.torrentText !== ""
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
