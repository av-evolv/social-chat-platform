//! Bounded, memory-only interoperability fixtures. Not a shipping crypto adapter.
//! Labels are deliberately unauthenticated; no account, storage or transport integration.
use openmls::prelude::{
    tls_codec::{Deserialize, Serialize},
    *,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use wasm_bindgen::prelude::*;

use crate::SUITE;

pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_PLAINTEXT_BYTES: usize = 1_024;
const MAX_OPERATIONS: usize = 256;

type FixtureResult<T> = Result<T, String>;

fn bounded(bytes: &[u8]) -> FixtureResult<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err("invalid_frame_size".into());
    }
    Ok(())
}

fn incoming(bytes: &[u8]) -> FixtureResult<MlsMessageIn> {
    bounded(bytes)?;
    MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| "invalid_frame".into())
}

fn protocol(bytes: &[u8], expected: ContentType) -> FixtureResult<ProtocolMessage> {
    let message = incoming(bytes)?
        .try_into_protocol_message()
        .map_err(|_| "unexpected_message_type".to_string())?;
    // Check before process_message, whose failure can mutate receive ratchets.
    if message.content_type() != expected {
        return Err("unexpected_message_type".into());
    }
    Ok(message)
}

#[wasm_bindgen]
pub struct FixturePeer {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    key_package: Option<Vec<u8>>,
    group: Option<MlsGroup>,
    added: bool,
    operations: usize,
}

impl FixturePeer {
    fn operation(&mut self) -> FixtureResult<()> {
        if self.operations >= MAX_OPERATIONS {
            return Err("operation_limit".into());
        }
        self.operations += 1;
        Ok(())
    }
}

#[wasm_bindgen]
impl FixturePeer {
    #[wasm_bindgen(constructor)]
    pub fn new(label: &str) -> FixtureResult<FixturePeer> {
        if label.is_empty() || label.len() > 64 || !label.is_ascii() {
            return Err("invalid_fixture_label".into());
        }
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SUITE.signature_algorithm())
            .map_err(|_| "fixture_identity_failed".to_string())?;
        signer
            .store(provider.storage())
            .map_err(|_| "fixture_storage_failed".to_string())?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(format!("larynx:fixture:{label}").into_bytes()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
            key_package: None,
            group: None,
            added: false,
            operations: 0,
        })
    }

    pub fn key_package(&mut self) -> FixtureResult<Vec<u8>> {
        self.operation()?;
        if let Some(bytes) = &self.key_package {
            return Ok(bytes.clone());
        }
        if self.group.is_some() {
            return Err("invalid_state".into());
        }
        let package = KeyPackage::builder()
            .build(SUITE, &self.provider, &self.signer, self.credential.clone())
            .map_err(|_| "key_package_failed".to_string())?;
        let message: MlsMessageOut = package.key_package().clone().into();
        let bytes = message
            .tls_serialize_detached()
            .map_err(|_| "encoding_failed".to_string())?;
        self.key_package = Some(bytes.clone());
        Ok(bytes)
    }

    pub fn create_group(&mut self) -> FixtureResult<()> {
        self.operation()?;
        if self.group.is_some() {
            return Err("invalid_state".into());
        }
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .build();
        self.group = Some(
            MlsGroup::new(
                &self.provider,
                &self.signer,
                &config,
                self.credential.clone(),
            )
            .map_err(|_| "create_failed".to_string())?,
        );
        Ok(())
    }

    pub fn add_member(&mut self, bytes: &[u8]) -> FixtureResult<Vec<u8>> {
        self.operation()?;
        if self.added {
            return Err("invalid_state".into());
        }
        let MlsMessageBodyIn::KeyPackage(package) = incoming(bytes)?.extract() else {
            return Err("unexpected_message_type".into());
        };
        let package = package
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|_| "invalid_key_package".to_string())?;
        let group = self.group.as_mut().ok_or("invalid_state")?;
        if group.members().count() != 1 {
            return Err("invalid_state".into());
        }
        let (_, welcome, _) = group
            .add_members(&self.provider, &self.signer, &[package])
            .map_err(|_| "add_failed".to_string())?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| "commit_failed".to_string())?;
        self.added = true;
        welcome.to_bytes().map_err(|_| "encoding_failed".into())
    }

    pub fn join(&mut self, bytes: &[u8]) -> FixtureResult<()> {
        self.operation()?;
        if self.group.is_some() {
            return Err("invalid_state".into());
        }
        let MlsMessageBodyIn::Welcome(welcome) = incoming(bytes)?.extract() else {
            return Err("unexpected_message_type".into());
        };
        let staged = StagedWelcome::new_from_welcome(
            &self.provider,
            &MlsGroupJoinConfig::default(),
            welcome,
            None,
        )
        .map_err(|_| "join_failed".to_string())?;
        self.group = Some(
            staged
                .into_group(&self.provider)
                .map_err(|_| "join_failed".to_string())?,
        );
        Ok(())
    }

    pub fn send(&mut self, bytes: &[u8]) -> FixtureResult<Vec<u8>> {
        self.operation()?;
        if bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err("invalid_plaintext_size".into());
        }
        self.group
            .as_mut()
            .ok_or("invalid_state")?
            .create_message(&self.provider, &self.signer, bytes)
            .map_err(|_| "send_failed".to_string())?
            .to_bytes()
            .map_err(|_| "encoding_failed".into())
    }

    pub fn receive(&mut self, bytes: &[u8]) -> FixtureResult<Vec<u8>> {
        self.operation()?;
        let message = protocol(bytes, ContentType::Application)?;
        let processed = self
            .group
            .as_mut()
            .ok_or("invalid_state")?
            .process_message(&self.provider, message)
            .map_err(|_| "receive_failed".to_string())?;
        let ProcessedMessageContent::ApplicationMessage(message) = processed.into_content() else {
            return Err("unexpected_message_type".into());
        };
        Ok(message.into_bytes())
    }

    pub fn remove_peer(&mut self) -> FixtureResult<Vec<u8>> {
        self.operation()?;
        let group = self.group.as_mut().ok_or("invalid_state")?;
        if group.members().count() != 2 {
            return Err("invalid_state".into());
        }
        let peer = group
            .members()
            .find(|member| member.index != group.own_leaf_index())
            .ok_or("invalid_state")?
            .index;
        let (commit, _, _) = group
            .remove_members(&self.provider, &self.signer, &[peer])
            .map_err(|_| "remove_failed".to_string())?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| "commit_failed".to_string())?;
        commit.to_bytes().map_err(|_| "encoding_failed".into())
    }

    pub fn apply_commit(&mut self, bytes: &[u8]) -> FixtureResult<()> {
        self.operation()?;
        let message = protocol(bytes, ContentType::Commit)?;
        let group = self.group.as_mut().ok_or("invalid_state")?;
        let processed = group
            .process_message(&self.provider, message)
            .map_err(|_| "commit_failed".to_string())?;
        let ProcessedMessageContent::StagedCommitMessage(commit) = processed.into_content() else {
            return Err("unexpected_message_type".into());
        };
        group
            .merge_staged_commit(&self.provider, *commit)
            .map_err(|_| "commit_failed".into())
    }

    pub fn authenticator(&self) -> FixtureResult<Vec<u8>> {
        Ok(self
            .group
            .as_ref()
            .ok_or("invalid_state")?
            .epoch_authenticator()
            .as_slice()
            .to_vec())
    }

    pub fn active(&self) -> bool {
        self.group.as_ref().is_some_and(MlsGroup::is_active)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_peer_lifecycle_and_recoverable_boundaries() {
        let mut creator = FixturePeer::new("creator").unwrap();
        let mut joiner = FixturePeer::new("joiner").unwrap();
        assert!(creator.send(b"no group").is_err());
        creator.create_group().unwrap();
        assert!(creator.create_group().is_err());
        let history = creator.send(b"pre-admission").unwrap();
        let package = joiner.key_package().unwrap();
        assert_eq!(package, joiner.key_package().unwrap());
        assert!(creator.add_member(&[]).is_err());
        let mut trailing = package.clone();
        trailing.push(0);
        assert!(creator.add_member(&trailing).is_err());
        assert!(creator.add_member(&vec![0; MAX_FRAME_BYTES + 1]).is_err());
        let welcome = creator.add_member(&package).unwrap();
        joiner.join(&welcome).unwrap();
        assert!(joiner.join(&welcome).is_err());
        assert!(creator.add_member(&package).is_err());
        assert_eq!(
            creator.authenticator().unwrap(),
            joiner.authenticator().unwrap()
        );
        assert!(joiner.receive(&history).is_err());
        assert!(joiner.receive(&package).is_err());
        assert!(creator.send(&vec![0; MAX_PLAINTEXT_BYTES + 1]).is_err());
        let mut bad = creator.send(b"tamper").unwrap();
        *bad.last_mut().unwrap() ^= 1;
        assert!(joiner.receive(&bad).is_err());
        let bytes = creator.send(b"fresh generation").unwrap();
        assert_eq!(joiner.receive(&bytes).unwrap(), b"fresh generation");
        assert!(joiner.receive(&bytes).is_err());
        let reply = joiner.send(b"reply").unwrap();
        assert_eq!(creator.receive(&reply).unwrap(), b"reply");
        let removal = creator.remove_peer().unwrap();
        assert_eq!(
            joiner.receive(&removal).unwrap_err(),
            "unexpected_message_type"
        );
        assert!(joiner
            .receive(&creator.send(b"post removal").unwrap())
            .is_err());
        joiner.apply_commit(&removal).unwrap();
        assert!(!joiner.active());
        assert!(joiner.send(b"removed").is_err());
    }

    #[test]
    fn fixture_limits_and_protocol_variants() {
        assert!(FixturePeer::new("").is_err());
        assert!(FixturePeer::new(&"x".repeat(65)).is_err());
        let mut peer = FixturePeer::new("bounded").unwrap();
        assert_eq!(peer.receive(&[]).unwrap_err(), "invalid_frame_size");
        assert_eq!(peer.receive(&[1, 2, 3]).unwrap_err(), "invalid_frame");
        let package = peer.key_package().unwrap();
        assert_eq!(peer.join(&package).unwrap_err(), "unexpected_message_type");
        assert_eq!(
            peer.apply_commit(&package).unwrap_err(),
            "unexpected_message_type"
        );
        for _ in peer.operations..MAX_OPERATIONS {
            peer.key_package().unwrap();
        }
        assert_eq!(peer.key_package().unwrap_err(), "operation_limit");
    }
}
