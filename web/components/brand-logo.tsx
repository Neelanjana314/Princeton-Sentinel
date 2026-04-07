import Image from "next/image";

import { cn } from "@/lib/utils";

const LIGHT_THEME_LOGO_SRC = "/pis-logo.png";
const DARK_THEME_LOGO_SRC = "/pits-white-logo.png";

type BrandLogoProps = {
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  className?: string;
};

export default function BrandLogo({ alt, width, height, priority = false, className }: BrandLogoProps) {
  return (
    <>
      <Image
        src={LIGHT_THEME_LOGO_SRC}
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={cn(className, "dark:hidden")}
      />
      <Image
        src={DARK_THEME_LOGO_SRC}
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={cn("hidden dark:block", className)}
      />
    </>
  );
}
