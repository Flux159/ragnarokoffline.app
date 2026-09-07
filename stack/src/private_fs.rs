//! Host-side protection for managed service material. Container-facing game
//! config can remain 0644 below a private Unix ancestor; Windows uses DACLs.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

const ERROR: &str = "Cannot protect private service files. Use an owner-controlled local filesystem with permissions support.";

pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    #[cfg(unix)]
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut value))
        .map_err(|_| "System random generation failed")?;
    #[cfg(windows)]
    unsafe {
        #[link(name = "bcrypt")]
        unsafe extern "system" {
            fn BCryptGenRandom(
                algorithm: *mut std::ffi::c_void,
                buffer: *mut u8,
                size: u32,
                flags: u32,
            ) -> i32;
        }
        let len = u32::try_from(bytes).map_err(|_| "System random request is too large")?;
        if BCryptGenRandom(std::ptr::null_mut(), value.as_mut_ptr(), len, 2) < 0 {
            return Err("System random generation failed".into());
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err("System random generation is not supported on this platform".into());
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn random_token(length: usize) -> Result<String, String> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let hex = random_hex(length)?;
    Ok((0..length)
        .map(|index| {
            let byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                .expect("hex generated above");
            ALPHABET[(byte & 63) as usize] as char
        })
        .collect())
}

fn new_file(path: &Path) -> Result<File, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|_| ERROR.into())
    }
    #[cfg(windows)]
    {
        windows::new_file(path)
    }
}

/// Export through a private adjacent temporary file. The source and destination
/// may be on different drives. Never inherit public destination ACLs, truncate
/// an old backup in place, or change permissions on the user's chosen folder.
pub fn export_file(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".ragnarok-backup-{}.tmp", random_hex(12)?));
    let result = (|| {
        let mut input = File::open(source).map_err(|_| "Cannot read the staged backup")?;
        let mut output = new_file(&temporary)?;
        std::io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|_| "Cannot write the private backup export")?;
        drop(output);
        #[cfg(unix)]
        {
            fs::rename(&temporary, destination)
                .map_err(|_| "Cannot replace the selected backup")?;
            File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|_| "Cannot sync the backup destination")?;
        }
        #[cfg(windows)]
        windows::replace(&temporary, destination)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn metadata(path: &Path) -> Result<fs::Metadata, String> {
    let info = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if info.file_type().is_symlink() {
        return Err(ERROR.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return Err(ERROR.into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        unsafe extern "C" {
            fn geteuid() -> u32;
        }
        if info.uid() != unsafe { geteuid() } {
            return Err(ERROR.into());
        }
    }
    Ok(info)
}

pub fn directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(path)
                .map_err(|_| ERROR)?;
        }
        #[cfg(windows)]
        fs::create_dir(path).map_err(|_| ERROR)?;
    }
    if !metadata(path)?.is_dir() {
        return Err(ERROR.into());
    }
    protect(path, true)
}

pub fn protect(path: &Path, directory: bool) -> Result<(), String> {
    let info = metadata(path)?;
    if directory != info.is_dir() || (!directory && !info.is_file()) {
        return Err(ERROR.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if !directory && info.nlink() != 1 {
            return Err(ERROR.into());
        }
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )
        .map_err(|_| ERROR)?;
    }
    #[cfg(windows)]
    {
        if !directory {
            windows::single_link(path)?;
        }
        windows::protect(path, directory)?;
    }
    Ok(())
}

/// The caller first protects the parent directory. Immutable secret material is
/// published once, fully written and synced; a partial write is never accepted.
pub fn create(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok() {
        return Err("Private service file already exists; it was not overwritten".into());
    }
    let parent = path.parent().ok_or(ERROR)?;
    directory(parent)?;
    let temporary = parent.join(format!(".private-{}.tmp", random_hex(12)?));
    let result = (|| {
        let mut file = new_file(&temporary)?;
        protect(&temporary, false)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| ERROR)?;
        drop(file);
        // The supervisor operation lock serializes managed writes. Recheck the
        // target to avoid replacing unrelated files after validation.
        if fs::symlink_metadata(path).is_ok() {
            return Err(ERROR.into());
        }
        fs::rename(&temporary, path).map_err(|_| ERROR)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| ERROR)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn read(path: &Path, limit: u64) -> Result<String, String> {
    protect(path, false)?;
    let mut body = String::new();
    File::open(path)
        .map_err(|_| ERROR)?
        .take(limit + 1)
        .read_to_string(&mut body)
        .map_err(|_| ERROR)?;
    if body.len() as u64 > limit {
        return Err("Private service file is too large".into());
    }
    Ok(body)
}

#[cfg(windows)]
mod windows {
    use super::ERROR;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn LocalFree(memory: Handle) -> Handle;
        fn GetFileInformationByHandle(file: Handle, information: *mut FileInfo) -> i32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            data: Handle,
            size: u32,
            required: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: Handle, output: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut Handle,
            size: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorOwner(
            descriptor: Handle,
            owner: *mut Handle,
            defaulted: *mut i32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: Handle,
            present: *mut i32,
            acl: *mut Handle,
            defaulted: *mut i32,
        ) -> i32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            kind: u32,
            info: u32,
            owner: Handle,
            group: Handle,
            dacl: Handle,
            sacl: Handle,
        ) -> u32;
    }
    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    pub fn single_link(path: &Path) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        let file = std::fs::File::open(path).map_err(|_| ERROR)?;
        let mut info: FileInfo = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0
            || info.links != 1
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
    struct Local(Handle);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    struct Token(Handle);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn current_sid() -> Result<String, String> {
        unsafe {
            let mut token = null_mut();
            if OpenProcessToken(GetCurrentProcess(), 8, &mut token) == 0 {
                return Err(ERROR.into());
            }
            let token = Token(token);
            let mut required = 0;
            GetTokenInformation(token.0, 1, null_mut(), 0, &mut required);
            if required == 0 || required > 65536 {
                return Err(ERROR.into());
            }
            // TOKEN_USER starts with a pointer. Allocate pointer-aligned storage.
            let mut data = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token.0,
                1,
                data.as_mut_ptr().cast(),
                required,
                &mut required,
            ) == 0
            {
                return Err(ERROR.into());
            }
            let sid = *(data.as_ptr() as *const Handle);
            let mut text = null_mut();
            if ConvertSidToStringSidW(sid, &mut text) == 0 {
                return Err(ERROR.into());
            }
            let allocated = Local(text.cast());
            let len = (0..256).find(|i| *text.add(*i) == 0).ok_or(ERROR)?;
            let value =
                String::from_utf16(std::slice::from_raw_parts(text, len)).map_err(|_| ERROR)?;
            drop(allocated);
            Ok(value)
        }
    }

    fn descriptor(directory: bool) -> Result<Local, String> {
        let sid = current_sid()?;
        let flags = if directory { "OICI" } else { "" };
        let text: Vec<u16> = format!("O:{sid}D:P(A;{flags};FA;;;{sid})(A;{flags};FA;;;SY)")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut sd = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        } == 0
        {
            return Err(ERROR.into());
        }
        Ok(Local(sd))
    }

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: Handle,
        inherit: i32,
    }
    pub fn new_file(path: &Path) -> Result<std::fs::File, String> {
        use std::os::windows::io::FromRawHandle;
        let sd = descriptor(false)?;
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: sd.0,
            inherit: 0,
        };
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                0xc0000000,
                7,
                &attributes,
                1,
                0x80,
                null_mut(),
            )
        };
        if handle == (-1isize as Handle) {
            return Err(ERROR.into());
        }
        Ok(unsafe { std::fs::File::from_raw_handle(handle) })
    }
    pub fn replace(source: &Path, destination: &Path) -> Result<(), String> {
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 9) } == 0 {
            return Err("Cannot replace the selected backup".into());
        }
        Ok(())
    }
    pub fn protect(path: &Path, directory: bool) -> Result<(), String> {
        let sd = descriptor(directory)?;
        let mut name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let (mut owner, mut acl) = (null_mut(), null_mut());
            let (mut defaulted, mut present) = (0, 0);
            if GetSecurityDescriptorOwner(sd.0, &mut owner, &mut defaulted) == 0
                || owner.is_null()
                || GetSecurityDescriptorDacl(sd.0, &mut present, &mut acl, &mut defaulted) == 0
                || present == 0
                || acl.is_null()
            {
                return Err(ERROR.into());
            }
            // Explicit owner and protected DACL; existing inherited grants are
            // replaced and newly created children inherit only owner + SYSTEM.
            if SetNamedSecurityInfoW(
                name.as_mut_ptr(),
                1,
                0x80000005,
                owner,
                null_mut(),
                acl,
                null_mut(),
            ) != 0
            {
                return Err(ERROR.into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_files_are_exact_immutable_and_bounded() {
        let path = std::env::temp_dir().join(format!("ro-private-{}", random_hex(12).unwrap()));
        directory(&path).unwrap();
        let file = path.join("secret");
        create(&file, b" example-only-value ").unwrap();
        assert_eq!(read(&file, 100).unwrap(), " example-only-value ");
        assert!(create(&file, b"replacement").is_err());
        assert!(read(&file, 3).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(&file).unwrap();
        fs::remove_dir(&path).unwrap();
    }
    #[test]
    fn exports_replace_existing_files_without_changing_the_destination_directory() {
        let root = std::env::temp_dir().join(format!("ro-export-{}", random_hex(12).unwrap()));
        directory(&root).unwrap();
        let source = root.join("source");
        create(&source, b"example-private-backup").unwrap();
        let destination = root.join("export");
        fs::write(&destination, "old contents").unwrap();
        export_file(&source, &destination).unwrap();
        assert_eq!(read(&destination, 100).unwrap(), "example-private-backup");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_file(source).unwrap();
        fs::remove_file(destination).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn links_never_become_service_secret_files() {
        let path =
            std::env::temp_dir().join(format!("ro-private-links-{}", random_hex(12).unwrap()));
        directory(&path).unwrap();
        let target = path.join("target");
        create(&target, b"not-a-secret").unwrap();
        let link = path.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read(&link, 100).is_err());
        assert!(create(&link, b"replacement").is_err());
        fs::remove_file(&link).unwrap();
        fs::hard_link(&target, &link).unwrap();
        assert!(read(&link, 100).is_err());
        fs::remove_file(&link).unwrap();
        fs::remove_file(&target).unwrap();
        fs::remove_dir(&path).unwrap();
    }
}
