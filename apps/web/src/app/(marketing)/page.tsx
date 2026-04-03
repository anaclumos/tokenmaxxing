import Hero from "@/components/marketing/Hero";
import Features from "@/components/marketing/Features";
import Testimonial from "@/components/marketing/Testimonial";
import CallToAction from "@/components/marketing/CallToAction";

export default function LandingPage() {
  return (
    <main className="relative mx-auto flex flex-col">
      <div className="pt-56">
        <Hero />
      </div>
      <div className="mt-52 px-4 xl:px-0">
        <Features />
      </div>
      <div className="mt-32 px-4 xl:px-0">
        <Testimonial />
      </div>
      <div className="mt-10 mb-40 px-4 xl:px-0">
        <CallToAction />
      </div>
    </main>
  );
}
