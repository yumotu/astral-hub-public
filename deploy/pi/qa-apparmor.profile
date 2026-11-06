# Applied only to the disposable GitHub Actions container. On newer Ubuntu,
# plain "unconfined" transitions new user namespaces into unprivileged_userns,
# which denies the namespace-local capabilities bubblewrap needs.
# https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/
abi <abi/4.0>,
profile astral-pi-qa flags=(unconfined) {
  userns,
}
