class ToastStore {
	toasts = $state([] as { message: string; id: number }[]);

	show(message: string) {
		console.log('showing toast', message);
		const id = Math.random();
		this.toasts = [...this.toasts, { message, id }];
		setTimeout(() => {
			this.toasts = this.toasts.filter((t) => t.id !== id);
		}, 2500);
	}
}

export const toastStore = new ToastStore();
