// @supabase/supabase-js pulls in @supabase/auth-js, etc. Metro's package "exports"
// resolution can fail or pick incompatible entry points. Expo/Supabase issues:
// https://github.com/supabase/supabase-js/issues/1258
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = false;

module.exports = config;
