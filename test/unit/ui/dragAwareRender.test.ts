import { DragAwareRender } from '../../../src/ui/DragAwareRender';

// The event sequences here are the ones Chromium delivers to a listener on the surface;
// see the note on DragAwareRender.
describe('DragAwareRender', () => {
	let render: jest.Mock;
	let renderer: DragAwareRender;

	beforeEach(() => {
		jest.useFakeTimers();
		render = jest.fn();
		renderer = new DragAwareRender(render);
	});

	test('renders straight away when nothing is being dragged', () => {
		renderer.request();
		renderer.request();

		expect(render).toHaveBeenCalledTimes(2);
	});

	// Re-rendering replaces the element under the pointer, and the browser then delivers
	// the drop to that removed element, where no listener hears it.
	test('does not render while something is being dragged over the surface', () => {
		renderer.dragEntered();
		renderer.dragOver();
		renderer.request();
		renderer.request();

		expect(render).not.toHaveBeenCalled();
	});

	test('renders once after the drop, however many requests were held back', () => {
		renderer.dragEntered();
		renderer.request();
		renderer.request();

		renderer.dropped();

		expect(render).toHaveBeenCalledTimes(1);
	});

	test('does not render after the drop if nothing was requested meanwhile', () => {
		renderer.dragEntered();
		renderer.dropped();

		expect(render).not.toHaveBeenCalled();
	});

	test('renders straight away again once the drag is over', () => {
		renderer.dragEntered();
		renderer.dropped();

		renderer.request();

		expect(render).toHaveBeenCalledTimes(1);
	});

	// Moving from one child to another fires dragenter on the new child, then dragleave on
	// the old one, and no dragover until the pointer next moves.
	test('keeps holding when the pointer moves from one child element to another', () => {
		renderer.dragEntered();
		renderer.request();

		renderer.dragEntered();
		renderer.dragLeft();
		jest.advanceTimersByTime(DragAwareRender.IDLE_TIMEOUT_MS - 1);

		expect(render).not.toHaveBeenCalled();
	});

	test('renders as soon as the drag leaves the surface', () => {
		renderer.dragEntered();
		renderer.dragEntered();
		renderer.dragLeft();
		renderer.request();

		renderer.dragLeft();

		expect(render).toHaveBeenCalledTimes(1);
	});

	test('holds again when the drag comes back onto the surface', () => {
		renderer.dragEntered();
		renderer.dragLeft();

		renderer.dragEntered();
		renderer.request();

		expect(render).not.toHaveBeenCalled();
	});

	test('a dragover is enough to hold, even if the dragenter was never seen', () => {
		renderer.dragOver();
		renderer.request();

		expect(render).not.toHaveBeenCalled();
	});

	// Should the browser never say the drag ended, the list must not stay frozen.
	test('gives up holding when no drag event has arrived for a while', () => {
		renderer.dragEntered();
		renderer.request();

		jest.advanceTimersByTime(DragAwareRender.IDLE_TIMEOUT_MS - 1);
		expect(render).not.toHaveBeenCalled();
		jest.advanceTimersByTime(1);

		expect(render).toHaveBeenCalledTimes(1);
	});

	test('a dragover restarts the idle countdown', () => {
		renderer.dragEntered();
		renderer.request();

		jest.advanceTimersByTime(DragAwareRender.IDLE_TIMEOUT_MS - 1);
		renderer.dragOver();
		jest.advanceTimersByTime(DragAwareRender.IDLE_TIMEOUT_MS - 1);

		expect(render).not.toHaveBeenCalled();
	});

	test('after giving up, a late dragleave is harmless and the next drag holds as usual', () => {
		renderer.dragEntered();
		jest.advanceTimersByTime(DragAwareRender.IDLE_TIMEOUT_MS);
		renderer.dragLeft();

		renderer.dragEntered();
		renderer.request();
		expect(render).not.toHaveBeenCalled();

		renderer.dragLeft();
		expect(render).toHaveBeenCalledTimes(1);
	});

	test('dispose stops any pending render', () => {
		renderer.dragEntered();
		renderer.request();

		renderer.dispose();
		jest.advanceTimersByTime(DragAwareRender.IDLE_TIMEOUT_MS);

		expect(render).not.toHaveBeenCalled();
	});
});
