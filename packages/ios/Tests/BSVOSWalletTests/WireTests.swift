import XCTest
@testable import BSVOSWallet

final class CallSurfaceTests: XCTestCase {
    func testAllTwentyEightCallsArePresent() {
        XCTAssertEqual(BRC100Call.allCases.count, 28)
    }

    func testWireCodesAreUniqueAndContiguous() {
        let codes = BRC100Call.allCases.map(\.wireCode).sorted()
        XCTAssertEqual(codes, Array(1...28), "wire codes must be 1...28 with no gaps or duplicates")
    }

    /// The wire codes are explicit, so a reordering of the enum cannot silently
    /// renumber the binary transport. This pins the ones an app client uses
    /// most, where a swap would be a subtle interop bug rather than a crash.
    func testKnownWireCodesAreStable() {
        XCTAssertEqual(BRC100Call.createAction.wireCode, 1)
        XCTAssertEqual(BRC100Call.getPublicKey.wireCode, 8)
        XCTAssertEqual(BRC100Call.encrypt.wireCode, 11)
        XCTAssertEqual(BRC100Call.decrypt.wireCode, 12)
        XCTAssertEqual(BRC100Call.isAuthenticated.wireCode, 23)
        XCTAssertEqual(BRC100Call.getVersion.wireCode, 28)
    }

    func testPublicReadsAreClassified() {
        for call in [BRC100Call.getVersion, .getNetwork, .getHeight, .getHeader] {
            XCTAssertTrue(call.isPublicRead, "\(call) is a public read")
            XCTAssertFalse(call.movesValueOrSigns, "\(call) does not move value")
        }
        XCTAssertFalse(BRC100Call.createAction.isPublicRead)
        XCTAssertTrue(BRC100Call.createAction.movesValueOrSigns)
    }
}

final class PrimitivesTests: XCTestCase {
    func testProtocolIDAcceptsAndRejectsExactlyWhatTheDaemonDoes() throws {
        // Ported from checkProtocolID: 5-400 chars, lowercase a-z0-9 space,
        // no consecutive spaces, and crucially NOT ending with " protocol" —
        // so "my protocol" is REJECTED by the daemon, which is easy to get
        // wrong when writing fixtures.
        _ = try ProtocolID(securityLevel: .named, name: "my protocol v2")
        _ = try ProtocolID(securityLevel: .open, name: "12345")
        _ = try ProtocolID(securityLevel: .privileged, name: "abcde")

        XCTAssertThrowsError(try ProtocolID(securityLevel: .named, name: "abcd")) { error in
            XCTAssertEqual(error as? ProtocolID.ValidationError, .nameTooShort)
        }
        XCTAssertThrowsError(try ProtocolID(securityLevel: .named, name: "My Protocol")) { error in
            XCTAssertEqual(error as? ProtocolID.ValidationError, .nameNotLowercase)
        }
        XCTAssertThrowsError(try ProtocolID(securityLevel: .named, name: "two  spaces")) { error in
            XCTAssertEqual(error as? ProtocolID.ValidationError, .consecutiveSpaces)
        }
        // Note this negative case uses the *invalid* name: "my protocol" ends
        // with " protocol" and the daemon rejects it. Every valid fixture above
        // therefore has to avoid that suffix.
        XCTAssertThrowsError(try ProtocolID(securityLevel: .named, name: "my protocol")) { error in
            XCTAssertEqual(error as? ProtocolID.ValidationError, .reservedSuffix)
        }
        XCTAssertThrowsError(try ProtocolID(securityLevel: .named, name: "has-hyphen")) { error in
            XCTAssertEqual(error as? ProtocolID.ValidationError, .nameNotLowercase)
        }
    }

    func testProtocolIDEncodesAsATwoElementArrayNotAnObject() throws {
        // The daemon does `Array.isArray(v) && v.length === 2`, so an object
        // shape would be rejected.
        let id = try ProtocolID(securityLevel: .named, name: "my protocol v2")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(id))
        XCTAssertEqual(json as? [AnyHashable], [1, "my protocol v2"])
    }

    func testCounterpartyAcceptsKeywordsAndCompressedKeysOnly() throws {
        XCTAssertEqual(try Counterparty(wireValue: "self"), .self)
        XCTAssertEqual(try Counterparty(wireValue: "anyone"), .anyone)
        let key = "02" + String(repeating: "ab", count: 32)
        XCTAssertEqual(try Counterparty(wireValue: key), .publicKey(key))

        // 33-byte compressed means 66 hex chars starting 02 or 03.
        XCTAssertThrowsError(try Counterparty(wireValue: "04" + String(repeating: "ab", count: 32)))
        XCTAssertThrowsError(try Counterparty(wireValue: String(repeating: "ab", count: 32)))
        XCTAssertThrowsError(try Counterparty(wireValue: "02" + String(repeating: "zz", count: 32)))

        // The daemon compares keywords with an exact `s === "self"`, so they are
        // case-sensitive while hex keys are not — an asymmetry worth pinning,
        // because "SELF" looks like it should work.
        XCTAssertThrowsError(try Counterparty(wireValue: "SELF"))
        XCTAssertThrowsError(try Counterparty(wireValue: "Anyone"))

        // Hex keys, by contrast, are accepted in either case and normalised.
        let upper = "02" + String(repeating: "AB", count: 32)
        XCTAssertEqual(try Counterparty(wireValue: upper), .publicKey(upper.lowercased()))
    }
}

final class WireEncodingTests: XCTestCase {
    /// The trap this pins: byte fields are JSON ARRAYS of integers, not base64.
    /// The daemon's checkBytes rejects base64 with `BAD_PARAM`. Swift's [UInt8]
    /// already produces the right shape, and this test keeps it that way.
    func testByteFieldsEncodeAsIntegerArraysNotBase64() throws {
        let id = try ProtocolID(securityLevel: .named, name: "my protocol v2")
        let request = EncryptRequest(protocolID: id, keyID: "k", plaintext: [1, 2, 3, 255])
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))

        XCTAssertTrue(json.contains("[1,2,3,255]"), "plaintext must be an integer array, got: \(json)")
        XCTAssertFalse(json.contains("AQID"), "plaintext must not be base64, got: \(json)")

        // And it round-trips.
        let decoded = try JSONDecoder().decode(EncryptRequest.self, from: data)
        XCTAssertEqual(decoded.plaintext, [1, 2, 3, 255])
    }

    /// Scripts are the opposite case: hex strings, not byte arrays.
    func testLockingScriptIsModelledAsHexString() throws {
        let json = """
        {"outputs":[{"satoshis":1,"spendable":true,"outpoint":"ab:0","lockingScript":"76a914deadbeef88ac"}],"totalOutputs":1}
        """
        let response = try JSONDecoder().decode(ListOutputsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.outputs.first?.lockingScript, "76a914deadbeef88ac")
        XCTAssertEqual(response.totalOutputs, 1)
    }

    func testSignatureRequestsRequireExactlyOneOfDataOrHash() throws {
        let id = try ProtocolID(securityLevel: .named, name: "my protocol v2")
        let neither = CreateSignatureRequest(protocolID: id, keyID: "k")
        XCTAssertThrowsError(try neither.validate()) { error in
            XCTAssertEqual(error as? CreateSignatureRequest.ValidationError, .needsDataOrHash)
        }
        let both = CreateSignatureRequest(data: [1], hashToDirectlySign: [2], protocolID: id, keyID: "k")
        XCTAssertThrowsError(try both.validate()) { error in
            XCTAssertEqual(error as? CreateSignatureRequest.ValidationError, .bothDataAndHash)
        }
        let one = CreateSignatureRequest(data: [1], protocolID: id, keyID: "k")
        XCTAssertNoThrow(try one.validate())
    }

    func testListOutputsIncludeEncodesTheDaemonsSpacedStrings() throws {
        // "locking scripts", not "lockingScripts" — the daemon compares the
        // exact string.
        let request = ListOutputsRequest(basket: "my basket", include: .lockingScripts)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(request), encoding: .utf8))
        XCTAssertTrue(json.contains("locking scripts"), "got: \(json)")
    }
}
