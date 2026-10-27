export default function Link({ href, prefetch: _prefetch, ...props }) {
  return <a href={href} {...props} />;
}
