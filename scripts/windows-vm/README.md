# Windows 11 test VM

An unattended Windows 11 install for testing things our own machines cannot:
Smart App Control on a fresh install, a first install that has never seen the
app, and the app on a small (8 GB) machine.

Full walkthrough: `mystral/docs/windowsvmtesting.md`.

## Use

1. Put your ssh public key into `autounattend.xml` in place of
   `REPLACE_WITH_YOUR_SSH_PUBLIC_KEY`.
2. Build the answer-file ISO (macOS):

   ```sh
   mkdir -p /tmp/unattend && cp autounattend.xml /tmp/unattend/
   hdiutil makehybrid -iso -joliet -default-volume-name UNATTEND \
       -o unattend.iso /tmp/unattend
   ```

3. Copy `unattend.iso` and a Windows 11 ISO to a Hyper-V host, then follow the
   VM creation steps in the doc.

The install needs no keyboard. When `C:\unattend-done.txt` exists, sshd is up
and the key is authorised.

## What it deliberately does not do

No Windows Update, no telemetry changes, no security settings touched. Smart App
Control decides what to do based on how the machine looks, so a machine we have
adjusted is not evidence about the machine a player has.
