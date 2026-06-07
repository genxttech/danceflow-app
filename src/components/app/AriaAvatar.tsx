type AriaAvatarProps = {
  size?: "sm" | "md" | "lg";
  className?: string;
};

const sizeClass = {
  sm: "h-10 w-10",
  md: "h-14 w-14",
  lg: "h-20 w-20",
};

export default function AriaAvatar({ size = "md", className = "" }: AriaAvatarProps) {
  return (
    <div
      className={`${sizeClass[size]} overflow-hidden rounded-full border-2 border-white bg-white shadow-sm ring-2 ring-[#F9A8D4]/70 ${className}`}
    >
      <img
        src="/aria/aria-avatar.png"
        alt="ARIA, DanceFlow's AI Revenue Insights Assistant"
        className="h-full w-full object-cover object-[50%_18%]"
      />
    </div>
  );
}
