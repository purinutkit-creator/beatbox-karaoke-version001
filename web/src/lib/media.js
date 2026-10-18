// Promotion slides: a picture, a video file, or a YouTube link.

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)(\?|#|$)/i;

/** The YouTube video id of a watch / share / shorts / embed link, or null. */
export function youtubeId(url) {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(url || '');
  return m ? m[1] : null;
}

/** 'YOUTUBE' | 'VIDEO' | 'IMAGE' for one promotion slide ({ image_url, media_type }). */
export function slideKind(item) {
  const url = item?.image_url || '';
  if (youtubeId(url)) return 'YOUTUBE';
  if (item?.media_type === 'VIDEO' || VIDEO_EXT.test(url)) return 'VIDEO';
  return 'IMAGE';
}

export const youtubeEmbed = (id) => `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&playsinline=1&rel=0&modestbranding=1`;
