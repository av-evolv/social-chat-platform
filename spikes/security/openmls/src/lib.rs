//! Disposable compatibility probe. No product credentials, storage, or transport.
use openmls::prelude::{tls_codec::Deserialize, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn identity(name: &[u8], provider: &OpenMlsRustCrypto) -> (CredentialWithKey, SignatureKeyPair) {
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    (
        CredentialWithKey {
            credential: BasicCredential::new(name.to_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        },
        signer,
    )
}

fn protocol(bytes: &[u8]) -> ProtocolMessage {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .unwrap()
        .try_into_protocol_message()
        .unwrap()
}

/// The same assertions run on the native host and, through WASM, in a browser.
/// BasicCredential names here are fixtures, NOT authenticated account identities.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn run_probe() -> String {
    let alice = OpenMlsRustCrypto::default();
    let bob = OpenMlsRustCrypto::default();
    let (alice_id, alice_signer) = identity(b"larynx:fixture:alice-device", &alice);
    let (bob_id, bob_signer) = identity(b"larynx:fixture:bob-device", &bob);
    let bob_package = KeyPackage::builder()
        .build(SUITE, &bob, &bob_signer, bob_id)
        .unwrap();
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(SUITE)
        .use_ratchet_tree_extension(true)
        .build();
    let mut a = MlsGroup::new(&alice, &alice_signer, &config, alice_id).unwrap();
    let before_join = a
        .create_message(&alice, &alice_signer, b"history before admission")
        .unwrap()
        .to_bytes()
        .unwrap();
    let (_, welcome, _) = a
        .add_members(&alice, &alice_signer, &[bob_package.key_package().clone()])
        .unwrap();
    a.merge_pending_commit(&alice).unwrap();
    let welcome = MlsMessageIn::tls_deserialize_exact(welcome.to_bytes().unwrap()).unwrap();
    let MlsMessageBodyIn::Welcome(welcome) = welcome.extract() else {
        panic!("expected welcome")
    };
    let mut b =
        StagedWelcome::new_from_welcome(&bob, &MlsGroupJoinConfig::default(), welcome, None)
            .unwrap()
            .into_group(&bob)
            .unwrap();
    assert_eq!(
        a.epoch_authenticator().as_slice(),
        b.epoch_authenticator().as_slice()
    );
    assert!(
        b.process_message(&bob, protocol(&before_join)).is_err(),
        "new member must not decrypt old epoch"
    );
    let bytes = a
        .create_message(&alice, &alice_signer, b"tamper fixture")
        .unwrap()
        .to_bytes()
        .unwrap();
    let mut tampered = bytes.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert!(
        b.process_message(&bob, protocol(&tampered)).is_err(),
        "tampering must fail"
    );
    // Processing a rejected ciphertext can consume its generation; use a fresh message.
    let bytes = a
        .create_message(&alice, &alice_signer, b"hello authorized member")
        .unwrap()
        .to_bytes()
        .unwrap();
    let processed = b.process_message(&bob, protocol(&bytes)).unwrap();
    let ProcessedMessageContent::ApplicationMessage(message) = processed.into_content() else {
        panic!("expected application message")
    };
    assert_eq!(message.into_bytes(), b"hello authorized member");
    assert!(
        b.process_message(&bob, protocol(&bytes)).is_err(),
        "replay must fail"
    );
    let (removal, _, _) = a
        .remove_members(&alice, &alice_signer, &[b.own_leaf_index()])
        .unwrap();
    a.merge_pending_commit(&alice).unwrap();
    let after_removal = a
        .create_message(&alice, &alice_signer, b"future private message")
        .unwrap()
        .to_bytes()
        .unwrap();
    // Even before learning about removal, the old member cannot read the new epoch.
    assert!(b.process_message(&bob, protocol(&after_removal)).is_err());
    let processed = b
        .process_message(&bob, protocol(&removal.to_bytes().unwrap()))
        .unwrap();
    let ProcessedMessageContent::StagedCommitMessage(commit) = processed.into_content() else {
        panic!("expected removal commit")
    };
    b.merge_staged_commit(&bob, *commit).unwrap();
    assert!(!b.is_active());
    assert!(b
        .create_message(&bob, &bob_signer, b"removed sender")
        .is_err());
    "PASS: join, equal epoch authenticator, no pre-join history, tamper rejection, authorized decrypt, replay rejection, removed-member exclusion, removed sender rejection".into()
}

#[test]
fn membership_and_ciphertext_boundaries() {
    println!("{}", run_probe());
}
