import { Image, StyleSheet, View } from 'react-native';

type GroupBannerProps = {
  imageUrl: string | null;
  groupName?: string;
  seasonLabel?: string;
};

export function GroupBanner({ imageUrl }: GroupBannerProps) {
  if (!imageUrl) return null;

  return (
    <View style={styles.container}>
      <Image source={{ uri: imageUrl }} style={styles.image} resizeMode="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 12,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  image: {
    width: '100%',
    height: 140,
    borderRadius: 12,
  },
});
