import Foundation

/// Repair the duration fields MediaRecorder leaves at zero.
///
/// The browser runs the same repair first (`cast/mp4.js`); the server runs it
/// again on upload, using the wall-clock length the recorder reports, so a
/// file whose client-side patch was skipped or lost still lands playable.
///
/// Safari (and Chrome 126+) record a fragmented MP4 whose `mvhd`, `tkhd`,
/// `mdhd` and `mehd` durations are zero — WebKit 216832 — and players show
/// 0:00 or refuse to start. Only zero fields are touched; 32- and 64-bit
/// versions are handled; anything unrecognised is returned unchanged.
public enum Mp4Duration {
    public static func looksLikeMp4(_ data: Data) -> Bool {
        guard data.count >= 12 else { return false }
        let bytes = [UInt8](data.prefix(8))
        return String(bytes: bytes[4..<8], encoding: .ascii) == "ftyp"
    }

    /// A copy of `data` with zero duration fields filled in from `durationMs`.
    public static func fix(_ data: Data, durationMs: Int) -> Data {
        guard durationMs > 0 else { return data }
        var bytes = [UInt8](data)
        let original = bytes

        guard let moov = firstBox(bytes, in: 0..<bytes.count, named: "moov"),
              let mvhd = firstBox(bytes, in: moov.payload..<moov.end, named: "mvhd") else {
            return data
        }
        let movieVersion = bytes[mvhd.start + 8]
        let movieTimescale = movieVersion == 1
            ? readU32(bytes, mvhd.start + 28)
            : readU32(bytes, mvhd.start + 20)
        guard movieTimescale > 0 else { return data }
        let movieDuration = Int((Double(durationMs) * Double(movieTimescale) / 1000).rounded())
        patchDuration(&bytes, box: mvhd, offsetV1: 32, offsetV0: 24, value: movieDuration, wide: movieVersion == 1)

        for box in boxes(bytes, in: moov.payload..<moov.end) {
            if box.type == "trak" {
                if let tkhd = firstBox(bytes, in: box.payload..<box.end, named: "tkhd") {
                    let version = bytes[tkhd.start + 8]
                    patchDuration(&bytes, box: tkhd, offsetV1: 36, offsetV0: 28, value: movieDuration, wide: version == 1)
                }
                if let mdia = firstBox(bytes, in: box.payload..<box.end, named: "mdia"),
                   let mdhd = firstBox(bytes, in: mdia.payload..<mdia.end, named: "mdhd") {
                    let version = bytes[mdhd.start + 8]
                    let timescale = version == 1 ? readU32(bytes, mdhd.start + 28) : readU32(bytes, mdhd.start + 20)
                    let trackDuration = timescale > 0
                        ? Int((Double(durationMs) * Double(timescale) / 1000).rounded())
                        : 0
                    patchDuration(&bytes, box: mdhd, offsetV1: 32, offsetV0: 24, value: trackDuration, wide: version == 1)
                }
            }
            if box.type == "mvex",
               let mehd = firstBox(bytes, in: box.payload..<box.end, named: "mehd") {
                let version = bytes[mehd.start + 8]
                patchDuration(&bytes, box: mehd, offsetV1: 12, offsetV0: 12, value: movieDuration, wide: version == 1)
            }
        }
        return bytes == original ? data : Data(bytes)
    }

    // MARK: - boxes

    private struct Box {
        var start: Int
        var end: Int
        var payload: Int
        var type: String
    }

    private static func boxes(_ bytes: [UInt8], in range: Range<Int>) -> [Box] {
        var out: [Box] = []
        var offset = range.lowerBound
        while offset + 8 <= range.upperBound {
            let size32 = readU32(bytes, offset)
            let type = String(bytes: bytes[(offset + 4)..<(offset + 8)], encoding: .ascii) ?? ""
            var size = Int(size32)
            var header = 8
            if size == 1 {
                guard offset + 16 <= range.upperBound else { break }
                size = Int(readU64(bytes, offset + 8))
                header = 16
            } else if size == 0 {
                size = range.upperBound - offset
            }
            guard size >= header, offset + size <= range.upperBound else { break }
            out.append(Box(start: offset, end: offset + size, payload: offset + header, type: type))
            offset += size
        }
        return out
    }

    private static func firstBox(_ bytes: [UInt8], in range: Range<Int>, named name: String) -> Box? {
        boxes(bytes, in: range).first { $0.type == name }
    }

    /// Patch a full-box duration field, but only when it is still zero.
    private static func patchDuration(
        _ bytes: inout [UInt8], box: Box, offsetV1: Int, offsetV0: Int, value: Int, wide: Bool
    ) {
        guard value > 0 else { return }
        let version = bytes[box.start + 8]
        let offset = box.start + (version == 1 ? offsetV1 : offsetV0)
        if wide {
            guard offset + 8 <= bytes.count else { return }
            guard readU64(bytes, offset) == 0 else { return }
            writeU64(&bytes, offset, UInt64(value))
        } else {
            guard offset + 4 <= bytes.count else { return }
            guard readU32(bytes, offset) == 0 else { return }
            writeU32(&bytes, offset, UInt32(min(value, Int(UInt32.max))))
        }
    }

    // MARK: - big-endian reads and writes

    private static func readU32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= bytes.count else { return 0 }
        return UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16
            | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3])
    }

    private static func readU64(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        guard offset >= 0, offset + 8 <= bytes.count else { return 0 }
        var value: UInt64 = 0
        for index in 0..<8 {
            value = value << 8 | UInt64(bytes[offset + index])
        }
        return value
    }

    private static func writeU32(_ bytes: inout [UInt8], _ offset: Int, _ value: UInt32) {
        bytes[offset] = UInt8((value >> 24) & 0xff)
        bytes[offset + 1] = UInt8((value >> 16) & 0xff)
        bytes[offset + 2] = UInt8((value >> 8) & 0xff)
        bytes[offset + 3] = UInt8(value & 0xff)
    }

    private static func writeU64(_ bytes: inout [UInt8], _ offset: Int, _ value: UInt64) {
        for index in 0..<8 {
            bytes[offset + index] = UInt8((value >> UInt64((7 - index) * 8)) & 0xff)
        }
    }
}
