//! One-shot OS identity query for the shell. No VM, Docker or PowerShell.

pub fn query(pid: u32) -> Result<String, String> {
    if pid == 0 {
        return Err("invalid process ID".into());
    }
    #[cfg(windows)]
    {
        windows::query(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("native process identity helper is only needed on Windows".into())
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    // Signatures and access rights:
    // https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
    // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetProcessTimes(
            handle: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn QueryFullProcessImageNameW(
            handle: Handle,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    struct Process(Handle);
    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: this owns a successful OpenProcess handle, closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn failure(operation: &str) -> String {
        format!("{operation}: {}", std::io::Error::last_os_error())
    }

    pub fn query(pid: u32) -> Result<String, String> {
        // SAFETY: numeric PID; query-only access, no inherited handle.
        let raw = unsafe { OpenProcess(0x1000, 0, pid) }; // PROCESS_QUERY_LIMITED_INFORMATION
        if raw.is_null() {
            return Err(failure("opening process for identity"));
        }
        let process = Process(raw);
        let (mut creation, mut exit, mut kernel, mut user) = (
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
        );
        // SAFETY: live owned handle and distinct valid output structures.
        if unsafe { GetProcessTimes(process.0, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err(failure("reading process creation time"));
        }
        let mut name = vec![0u16; 32768];
        let mut size = name.len() as u32;
        // SAFETY: size names the allocated UTF-16 buffer; Win32 reports the
        // number of initialized characters excluding its trailing NUL.
        if unsafe { QueryFullProcessImageNameW(process.0, 0, name.as_mut_ptr(), &mut size) } == 0 {
            return Err(failure("reading process executable"));
        }
        if size as usize >= name.len() {
            return Err("oversized executable path".into());
        }
        let executable = String::from_utf16(&name[..size as usize]).map_err(|e| e.to_string())?;
        let stamp = (u64::from(creation.high) << 32) | u64::from(creation.low);
        Ok(format!(
            "{{\"start\":\"windows-filetime:{stamp:016x}\",\"executable\":{}}}",
            crate::json::quote(&executable)
        ))
    }

    #[test]
    fn current_process_identity_is_stable_and_names_this_executable() {
        let first = query(std::process::id()).unwrap();
        assert_eq!(query(std::process::id()).unwrap(), first);
        let value = crate::json::parse(&first).unwrap();
        assert!(value.str("start").unwrap().starts_with("windows-filetime:"));
        assert_eq!(
            std::path::Path::new(value.str("executable").unwrap()),
            std::env::current_exe().unwrap()
        );
        assert!(query(u32::MAX).is_err());
    }
}
