import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { CategoryChips, type Category } from "@/components/CategoryChips";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);

const categories: Category[] = [
  { key: "events", label: "Events", count: 12, href: "/discover/events", guestAllowed: true },
  { key: "studios", label: "Studios", count: 3, href: "/discover/studios", guestAllowed: true },
  { key: "jobs", label: "Jobs", count: null, href: "/jobs" },
];

describe("Discover category chips", () => {
  it("is a horizontal row that does not grow to fill the screen (stretched-chip regression)", () => {
    render(<CategoryChips categories={categories} loading={false} onOpen={jest.fn()} />);
    const row = screen.getByTestId("discover-chips");
    expect(row.props.horizontal).toBe(true);
    // A ScrollView defaults to flexGrow 1; left alone it stretched to the column height (about 680 px).
    expect(StyleSheet.flatten(row.props.style).flexGrow).toBe(0);
  });

  it("keeps each chip a compact pill with a minimum, not a fixed or growing, height", () => {
    render(<CategoryChips categories={categories} loading={false} onOpen={jest.fn()} />);
    const style = screen.getByTestId("discover-chip-events").props.style;
    const chip = StyleSheet.flatten(typeof style === "function" ? style({ pressed: false }) : style);
    expect(chip.minHeight).toBe(44);
    expect(chip.height).toBeUndefined();
    expect(chip.flexGrow).toBeUndefined();
  });

  it("labels counts once loaded and hides them while loading", () => {
    const { rerender } = render(<CategoryChips categories={categories} loading={false} onOpen={jest.fn()} />);
    expect(screen.getByLabelText("Events, 12")).toBeTruthy();
    expect(screen.getByLabelText("Jobs")).toBeTruthy();
    rerender(<CategoryChips categories={categories} loading onOpen={jest.fn()} />);
    expect(screen.getByLabelText("Events")).toBeTruthy();
  });

  it("opens the pressed category", () => {
    const onOpen = jest.fn();
    render(<CategoryChips categories={categories} loading={false} onOpen={onOpen} />);
    fireEvent.press(screen.getByTestId("discover-chip-studios"));
    expect(onOpen).toHaveBeenCalledWith(categories[1]);
  });
});
