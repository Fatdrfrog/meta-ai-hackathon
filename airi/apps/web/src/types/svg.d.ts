declare module "*.svg" {
  const image: {
    src: string;
    height: number;
    width: number;
    blurWidth?: number;
    blurHeight?: number;
  };

  export default image;
}
