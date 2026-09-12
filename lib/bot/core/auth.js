export function isAdminUser(user) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
  return Boolean(adminId && user?.id && String(user.id) === adminId);
}

export function isAdminMessage(message) {
  return isAdminUser(message?.from);
}
