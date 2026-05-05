/**
 * Below are the colors that are used in the app.
 * Styled to match the Late Add v1 Glide app design.
 */

import { Platform } from 'react-native';

const oliveGreen = '#4B5E2A';
const oliveGreenLight = '#5A7032';

export const Colors = {
  light: {
    text: '#1A1A1A',
    background: '#F5F5F5',
    tint: oliveGreen,
    icon: '#8E8E93',
    tabIconDefault: '#8E8E93',
    tabIconSelected: oliveGreen,
    card: '#FFFFFF',
    headerBg: oliveGreen,
    headerText: '#FFFFFF',
    border: '#E0E0E0',
    positive: '#2E7D32',
    positiveBg: '#E8F5E9',
    negative: '#C62828',
    negativeBg: '#FFEBEE',
    pillPositive: '#E8F5E9',
    pillNegative: '#FFEBEE',
    venmoBlue: '#008CFF',
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: '#8FAF5A',
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: '#8FAF5A',
    card: '#1C1C1E',
    headerBg: '#2A3518',
    headerText: '#FFFFFF',
    border: '#333',
    positive: '#66BB6A',
    positiveBg: '#1B3D1B',
    negative: '#EF5350',
    negativeBg: '#3D1B1B',
    pillPositive: '#1B3D1B',
    pillNegative: '#3D1B1B',
    venmoBlue: '#4DA6FF',
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
